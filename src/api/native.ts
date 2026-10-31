import { WebAPI } from '../web-client.mjs';
import { frames, generation, protocolError } from '../web-protocol.mjs';
import { attachmentFields, operationFields, parseHistoryPage } from './protocol.ts';
import { ApiError, canonical, samePosition } from './types.ts';
import type { Attachment, Backend, BackendChat, Generation, Observation, Position, TurnData, UploadSource } from './types.ts';

export class NativeBackend implements Backend {
  api: WebAPI;
  pollMs: number;
  constructor(options: { api?: WebAPI; pollMs?: number } = {}) { this.api = options.api ?? new WebAPI(); this.pollMs = options.pollMs ?? 250; }
  private account(accountId = 'default') { if (accountId !== 'default') throw new ApiError('ACCOUNT_NOT_CONFIGURED', 'Only the configured default account is available', 400); }
  async capabilities(accountId = 'default') {
    this.account(accountId);
    return { models: ['argon'], send: true, fork: true, regenerate: true, select: true, nativeMcp: false };
  }
  async history(cid: string, accountId = 'default'): Promise<TurnData[]> {
    this.account(accountId);
    const pages: TurnData[][] = [], cursors = new Set<string>(), positions = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const raw = await this.api.history(cid, 20, cursor);
      const rejection = protocolError(raw);
      if (rejection) throw new ApiError('UPSTREAM_HISTORY_REJECTED', `Upstream history RPC ${rejection.rpcCode}, BardErrorInfo ${rejection.code ?? 'unspecified'}`, 502);
      const { turns, nextPageToken } = parseHistoryPage(raw);
      if (turns.some(t => t.position.cid !== cid)) throw new ApiError('UPSTREAM_HISTORY_MISMATCH');
      for (const turn of turns) {
        const key = canonical(turn.position);
        if (positions.has(key)) throw new ApiError('UPSTREAM_HISTORY_CHANGED');
        positions.add(key);
      }
      pages.push(turns);
      if (!nextPageToken) return pages.reverse().flat();
      if (cursors.has(nextPageToken)) throw new ApiError('UPSTREAM_HISTORY_INVALID_CURSOR');
      cursors.add(nextPageToken); cursor = nextPageToken;
    }
  }
  async upload(bytes: UploadSource, name: string, accountId = 'default'): Promise<Attachment> {
    this.account(accountId);
    try {
      const [reference] = await this.api.upload([bytes instanceof Uint8Array ? { name, bytes } : { name, path: bytes.path }]);
      return { name, reference, size: bytes instanceof Uint8Array ? bytes.length : bytes.size };
    } catch (error) {
      const status = error instanceof Error && /^HTTP_(400|401|403|413|415|429)$/.exec(error.message);
      if (status) throw new ApiError('UPLOAD_REJECTED', `Upstream upload HTTP ${status[1]}`, Number(status[1]));
      throw error;
    }
  }
  async generate(input: Generation, observe: (event: Observation) => void): Promise<TurnData> {
    this.account(input.accountId);
    if (input.model !== 'argon') throw new ApiError('GENERATION_REJECTED', 'MODEL_UNAVAILABLE', 400);
    if (input.temporary && input.operation !== 'send') throw new ApiError('GENERATION_REJECTED', 'Temporary chats support send only', 400);
    const fields = operationFields(input.operation, input.operation === 'send' ? input.parent : input.at, input.parent);
    const id = await this.api.start({ id: input.id, prompt: input.input.text, metadata: fields.metadata, files: input.input.files.map(attachmentFields), temporary: input.temporary, ...(fields.operationFlag === undefined ? {} : { operationFlag: fields.operationFlag }) });
    let lastText = '', observed: Position | undefined;
    try { for (;;) {
      const state = await this.api.poll(id) as any;
      const parsed = (state.response ?? generation(state.raw ?? '')) as { text: string; metadata: string[] | null; complete: boolean };
      if (parsed.metadata?.[0] && parsed.metadata[1]) {
        const p = { cid: parsed.metadata[0], rid: parsed.metadata[1], rcid: parsed.metadata[2] };
        if (!samePosition(observed, p)) { observed = p; observe({ type: 'position', position: p }); }
      }
      if (parsed.text.startsWith(lastText) && parsed.text.length > lastText.length) observe({ type: 'text.delta', delta: parsed.text.slice(lastText.length) });
      else if (parsed.text !== lastText) observe({ type: 'text.replace', text: parsed.text });
      lastText = parsed.text;
      if (state.done) {
        observe({ type: 'diagnostics', diagnostics: { transportError: state.error, exhausted: !!state.exhausted, complete: parsed.complete, receivedChars: state.receivedChars ?? state.raw?.length ?? 0, model: state.model, elapsedMs: state.elapsedMs, httpStatus: state.status, transport: state.transportDiagnostics, proxyError: state.proxyError, network: state.network } });
        if (state.error && ['authentication', 'proof'].includes(state.stage)) throw new ApiError('GENERATION_REJECTED', state.error, state.error.startsWith('PROXY_')||state.error==='NETWORK_UNREACHABLE'?503:401);
        const rejection = state.rejection ?? protocolError(state.raw ?? '');
        if (rejection) {
          const code = !observed && rejection.rpcCode === 9 && Number.isInteger(rejection.code) ? 'GENERATION_REJECTED' : 'UPSTREAM_UNCERTAIN';
          throw new ApiError(code, `Upstream RPC ${rejection.rpcCode}, BardErrorInfo ${rejection.code ?? 'unspecified'}`, 502);
        }
        if (state.error || !state.exhausted || !parsed.complete || !observed) throw new ApiError('UPSTREAM_UNCERTAIN', `Generation did not reach verified completion: ${state.error ?? (!state.exhausted ? 'STREAM_NOT_EXHAUSTED' : !parsed.complete ? 'CANDIDATE_INCOMPLETE' : 'POSITION_MISSING')}`);
        if (input.temporary) {
          const position = observed;
          if (!/^c_[a-f0-9]+$/.test(position.cid) || !/^r_[a-f0-9]+$/.test(position.rid) || !/^rc_[a-f0-9]+$/.test(position.rcid ?? '') ||
              (input.cid && position.cid !== input.cid) || input.baseline.some(p => p.cid === position.cid && p.rid === position.rid)) {
            throw new ApiError('UPSTREAM_UNCERTAIN', 'Temporary stream has invalid or stale turn identifiers');
          }
          // Temporary chats have no readable upstream history; require the entire response stream.
          return { position, input: input.input, output: { text: parsed.text } };
        }
        const recovered = await this.recover(input, observed);
        if (!recovered) throw new ApiError('UPSTREAM_UNCERTAIN', 'Completed stream has no matching committed history');
        return recovered;
      }
      await new Promise(r => setTimeout(r, this.pollMs));
    } } finally { this.api.release?.(id); }
  }
  async recover(input: Generation, observed?: Position): Promise<TurnData | null> {
    if (input.temporary) return null;
    if (!observed || input.baseline.some(p => p.cid === observed.cid && p.rid === observed.rid)) return null;
    let turns: TurnData[];
    try { turns = await this.history(observed.cid, input.accountId); }
    catch (error) { if (error instanceof ApiError && error.code === 'UPSTREAM_INCOMPLETE') return null; throw error; }
    // The first stream frame provides cid/rid before the candidate exists.
    const index = turns.findIndex(t => t.position.cid === observed.cid && t.position.rid === observed.rid && (!observed.rcid || t.position.rcid === observed.rcid));
    if (index < 0) return null;
    const match = turns[index];
    if (match.input.text !== input.input.text) return null;
    if (input.parent && !samePosition(turns[index - 1]?.position, input.parent)) return null;
    if (!input.parent && index !== 0) return null;
    // Some history attachment records have a different shape than upload refs;
    // retain the submitted references only for the independently matched turn.
    return { ...match, input: { text: match.input.text, files: input.input.files } };
  }
  private rpcResult(raw: string, name: string): any {
    if (protocolError(raw)) throw new ApiError('UPSTREAM_RPC_FAILED', 'Upstream rejected RPC', 502);
    const frame = frames(raw).find((f: any) => f[0] === 'wrb.fr' && f[1] === name && typeof f[2] === 'string');
    if (!frame) throw new ApiError('UPSTREAM_RPC_FAILED', 'Missing RPC result', 502);
    return JSON.parse(frame[2]);
  }
  async fork(at: Position, accountId = 'default'): Promise<BackendChat> {
    this.account(accountId);
    const before = await this.history(at.cid, accountId);
    const index = before.findIndex(t => samePosition(t.position, at));
    if (index < 0) throw new ApiError('POSITION_UNSUPPORTED');
    const data = this.rpcResult(await this.api.rpc('KDNZr', [at.cid, at.rid]), 'KDNZr');
    const cid = data?.[0]?.[0];
    if (typeof cid !== 'string' || !/^c_[a-f0-9]+$/.test(cid) || cid === at.cid) throw new ApiError('UPSTREAM_RPC_FAILED');
    const turns = await this.history(cid, accountId);
    if (turns.length !== index + 1 || turns.some((t, i) => t.input.text !== before[i].input.text || t.output.text !== before[i].output.text)) throw new ApiError('UPSTREAM_FORK_MISMATCH');
    return { cid, turns };
  }
  async select(at: Position, accountId = 'default') {
    this.account(accountId);
    this.rpcResult(await this.api.rpc('kOWVAe', [at.cid, at.rid, at.rcid]), 'kOWVAe');
    // This marks the selected context. Native history can still return the most
    // recently generated version until a follow-up is appended to the selection.
  }
}
