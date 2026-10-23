import { WebAPI, GENERATION_WAIT_MS } from '../web-client.mjs';
import { frames, generation, protocolError } from '../web-protocol.mjs';
import { attachmentFields, operationFields, parseHistory } from './protocol.ts';
import { ApiError, canonical, samePosition } from './types.ts';
import type { Attachment, Backend, BackendChat, Generation, Observation, Position, TurnData } from './types.ts';

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
    // Grow the native limit rather than silently treating a truncated tail as the
    // whole conversation. Beyond this bound the caller gets an explicit error.
    for (const limit of [20, 80, 320, 1000]) {
      const turns = parseHistory(await this.api.history(cid, limit));
      if (turns.some(t => t.position.cid !== cid)) throw new ApiError('UPSTREAM_HISTORY_MISMATCH');
      if (turns.length < limit) return turns;
    }
    throw new ApiError('HISTORY_LIMIT', 'Conversation exceeds the supported history window');
  }
  async upload(bytes: Uint8Array, name: string, accountId = 'default'): Promise<Attachment> {
    this.account(accountId);
    const [reference] = await this.api.upload([{ name, base64: Buffer.from(bytes).toString('base64') }]);
    return { name, reference, size: bytes.length };
  }
  async generate(input: Generation, observe: (event: Observation) => void): Promise<TurnData> {
    this.account(input.accountId);
    if (input.model !== 'argon') throw new ApiError('GENERATION_REJECTED', 'MODEL_UNAVAILABLE', 400);
    const fields = operationFields(input.operation, input.operation === 'send' ? input.parent : input.at, input.parent);
    const id = await this.api.start({ id: input.id, prompt: input.input.text, metadata: fields.metadata, files: input.input.files.map(attachmentFields), ...(fields.operationFlag === undefined ? {} : { operationFlag: fields.operationFlag }) });
    let lastText = '', observed: Position | undefined;
    const started = Date.now();
    for (;;) {
      const state = await this.api.poll(id) as any;
      const parsed = generation(state.raw ?? '') as { text: string; metadata: string[] | null; complete: boolean };
      if (parsed.metadata?.[0] && parsed.metadata[1]) {
        const p = { cid: parsed.metadata[0], rid: parsed.metadata[1], rcid: parsed.metadata[2] };
        if (!samePosition(observed, p)) { observed = p; observe({ type: 'position', position: p }); }
      }
      // Replacements are possible upstream. Only append genuine prefix deltas;
      // the final Turn remains authoritative if the upstream revises its text.
      if (parsed.text.startsWith(lastText) && parsed.text.length > lastText.length) observe({ type: 'text.delta', delta: parsed.text.slice(lastText.length) });
      lastText = parsed.text;
      if (state.done) {
        if (state.error && ['authentication', 'proof'].includes(state.stage)) throw new ApiError('GENERATION_REJECTED', state.error, 401);
        const rejection = protocolError(state.raw ?? '');
        if (rejection) {
          const code = !observed && rejection.rpcCode === 9 && Number.isInteger(rejection.code) ? 'GENERATION_REJECTED' : 'UPSTREAM_UNCERTAIN';
          throw new ApiError(code, `Upstream RPC ${rejection.rpcCode}, BardErrorInfo ${rejection.code ?? 'unspecified'}`, 502);
        }
        if (state.error || !state.exhausted || !parsed.complete || !observed) throw new ApiError('UPSTREAM_UNCERTAIN', 'Generation did not reach verified completion');
        const recovered = await this.recover(input, observed);
        if (!recovered) throw new ApiError('UPSTREAM_UNCERTAIN', 'Completed stream has no matching committed history');
        return recovered;
      }
      if (Date.now() - started > GENERATION_WAIT_MS) throw new ApiError('UPSTREAM_UNCERTAIN', 'Generation wait expired; request was not resubmitted');
      await new Promise(r => setTimeout(r, this.pollMs));
    }
  }
  async recover(input: Generation, observed?: Position): Promise<TurnData | null> {
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
