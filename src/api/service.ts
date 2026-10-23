import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.ts';
import { MAX_FILE_BYTES } from '../upload-limits.mjs';
import { ApiError, canonical, fail, samePosition } from './types.ts';
import type { Attachment, AttachChat, Backend, ChatInfo, CreateChat, FileRef, ForkInput, ForkResult, Generation, Input, Position, RunInfo, Turn, TurnData } from './types.ts';

const idSchema = z.string().min(1).max(200);
const positionSchema = z.object({ cid: z.string().regex(/^c_[a-f0-9]+$/), rid: z.string().regex(/^r_[a-f0-9]+$/), rcid: z.string().regex(/^rc_[a-f0-9]+$/) }).strict();
const textSchema = z.string().min(1).max(120000);
const inputSchema = z.object({ text: textSchema, files: z.array(idSchema).max(8).optional() }).strict();
const forkSchema = z.union([
  z.object({ mode: z.literal('new-chat').optional(), at: positionSchema }).strict(),
  z.object({ mode: z.literal('in-place'), at: positionSchema, input: z.object({ text: textSchema }).strict() }).strict(),
]);
function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail('INVALID_INPUT', 400);
  return parsed.data;
}
type ChatRecord = ChatInfo & { busy?: string; observedHead?: Position };
type RunRecord = RunInfo & { generation: Generation; observed?: Position };
type Idempotency = { signature: string; kind: 'run' | 'value' | 'operation'; id?: string; value?: any; status?: 'pending' | 'uncertain' };

export class ApiService {
  store: Store;
  backend: Backend;
  closed = false;
  private locks = new Map<string, Promise<void>>();
  constructor(options: { database: string; backend: Backend }) {
    this.store = new Store(options.database); this.backend = options.backend;
    this.store.transaction(() => {
      for (const run of this.store.list<RunRecord>('runs')) {
        if (run.status === 'running' || run.status === 'waiting_tool') {
          run.status = 'uncertain'; run.error = { code: 'PROCESS_INTERRUPTED', message: 'Query upstream before any retry' };
          this.store.put('runs', run.id, run); this.store.event(run.id, 'run.uncertain', { error: run.error });
        }
      }
      for (const [key, entry] of this.idempotencyEntries()) {
        if (entry.kind === 'operation' && entry.status === 'pending') this.store.put('idempotency', key, { ...entry, status: 'uncertain' });
      }
    });
  }
  private idempotencyEntries(): [string, Idempotency][] {
    return this.store.db.prepare("SELECT id,data FROM records WHERE ns='idempotency'").all().map(row => [String(row.id), JSON.parse(String(row.data))]);
  }
  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const before = this.locks.get(id) ?? Promise.resolve();
    let unlock!: () => void;
    const gate = new Promise<void>(r => { unlock = r; });
    const tail = before.then(() => gate); this.locks.set(id, tail);
    await before;
    try { if (this.closed) fail('SERVICE_CLOSED', 503); return await action(); }
    finally { unlock(); if (this.locks.get(id) === tail) this.locks.delete(id); }
  }
  private key(scope: string, key: string) { validate(idSchema, key); return `${scope}:${key}`; }
  private replay(scope: string, key: string, payload: unknown): any | undefined {
    const old = this.store.get<Idempotency>('idempotency', this.key(scope, key));
    if (!old) return undefined;
    if (old.signature !== canonical(payload)) fail('IDEMPOTENCY_CONFLICT');
    if (old.kind === 'run') return this.getRun(old.id!);
    if (old.kind === 'operation') throw new ApiError('OPERATION_UNCERTAIN', 'The upstream operation may have completed; it will not be repeated');
    return old.value;
  }
  private remember(scope: string, key: string, payload: unknown, value: Idempotency) {
    this.store.put('idempotency', this.key(scope, key), { ...value, signature: canonical(payload) });
  }
  private chat(id: string): ChatRecord { const value = this.store.get<ChatRecord>('chats', id); if (!value) fail('CHAT_NOT_FOUND', 404); return value; }
  getChat(id: string): ChatInfo { const { busy, observedHead, ...info } = this.chat(id); return info; }
  getRun(id: string): RunInfo {
    const run = this.store.get<RunRecord>('runs', id); if (!run) fail('RUN_NOT_FOUND', 404);
    const { generation, observed, ...info } = run; return info;
  }
  events(id: string, after: number) { this.getRun(id); if (!Number.isSafeInteger(after) || after < 0) fail('INVALID_CURSOR', 400); return this.store.events(id, after); }
  async capabilities(accountId = 'default') { return this.backend.capabilities(accountId); }
  async createChat(options: CreateChat, key: string): Promise<ChatInfo> {
    const parsed = validate(z.object({ accountId: idSchema.default('default'), model: idSchema, tools: z.object({ toolset: idSchema }).strict().optional() }).strict(), options);
    return this.locked('create', async () => {
      const old = this.replay('create', key, parsed); if (old) return old;
      const caps = await this.backend.capabilities(parsed.accountId);
      if (!caps.models.includes(parsed.model)) fail('MODEL_UNAVAILABLE', 400);
      // Binding native MCP to an API-created conversation is not yet verified.
      if (parsed.tools) fail('CAPABILITY_UNAVAILABLE', 400);
      const chat: ChatInfo = { id: randomUUID(), accountId: parsed.accountId, model: parsed.model, revision: 0, toolBinding: 'none' };
      this.store.transaction(() => { this.store.put('chats', chat.id, chat); this.remember('create', key, parsed, { kind: 'value', signature: '', value: chat }); });
      return chat;
    });
  }
  async attach(options: AttachChat, key: string): Promise<ChatInfo> {
    const parsed = validate(z.object({ accountId: idSchema.default('default'), upstream: z.object({ cid: positionSchema.shape.cid }).strict() }).strict(), options);
    return this.locked('attach', async () => {
      const old = this.replay('attach', key, parsed); if (old) return old;
      const caps = await this.backend.capabilities(parsed.accountId);
      const existing = this.store.list<ChatRecord>('chats').find(c => c.accountId === parsed.accountId && c.upstream?.cid === parsed.upstream.cid);
      return this.locked(existing?.id ?? `attach:${parsed.upstream.cid}`, async () => {
        const current = existing ? this.chat(existing.id) : undefined;
        if (current?.busy) fail('CHAT_BUSY');
        const turns = await this.backend.history(parsed.upstream.cid, parsed.accountId);
        if (this.closed) fail('SERVICE_CLOSED', 503);
        if (!turns.length) fail('CHAT_NOT_ACCESSIBLE', 404);
        const head = turns.at(-1)!.position;
        const chat: ChatRecord = current ?? {
          id: randomUUID(), accountId: parsed.accountId, model: caps.models[0], revision: 0,
          upstream: parsed.upstream, head, toolBinding: 'unverified',
        };
        if (current && !samePosition(current.observedHead ?? current.head, head)) {
          chat.head = head; chat.observedHead = head; chat.revision++;
        }
        this.store.transaction(() => {
          this.store.put('chats', chat.id, chat);
          this.remember('attach', key, parsed, { kind: 'value', signature: '', value: this.getChat(chat.id) });
        });
        return this.getChat(chat.id);
      });
    });
  }
  private async check(chat: ChatRecord, revision: number): Promise<TurnData[]> {
    if (chat.busy) fail('CHAT_BUSY');
    if (!Number.isSafeInteger(revision) || chat.revision !== revision) fail('CHAT_CHANGED');
    if (!chat.upstream) return [];
    const turns = await this.backend.history(chat.upstream.cid, chat.accountId);
    if (!samePosition(chat.observedHead ?? chat.head, turns.at(-1)?.position)) fail('CHAT_CHANGED');
    return this.decorate(chat.id, this.project(chat, turns));
  }
  private project(chat: ChatRecord, turns: TurnData[]): TurnData[] {
    if (!chat.head || samePosition(chat.head, turns.at(-1)?.position)) return turns;
    if (!samePosition(chat.observedHead, turns.at(-1)?.position)) fail('CHAT_CHANGED');
    const record = this.store.list<RunRecord>('runs').find(r => r.chatId === chat.id && r.status === 'completed' && samePosition(r.turn?.position, chat.head));
    if (!record?.turn) fail('POSITION_UNSUPPORTED');
    return [...turns.slice(0, -1), { position: record.turn.position, input: record.generation.input, output: record.turn.output }];
  }
  private decorate(chatId: string, turns: TurnData[]): TurnData[] {
    const groups = this.store.list<{ chatId: string; positions: Position[] }>('versions').filter(v => v.chatId === chatId);
    return turns.map(turn => {
      const group = groups.find(g => g.positions.some(p => samePosition(p, turn.position)));
      return group ? { ...turn, versions: group.positions } : turn;
    });
  }
  private find(chat: ChatRecord, at: Position, turns: TurnData[]) {
    if (at.cid !== chat.upstream?.cid) fail('POSITION_UNSUPPORTED');
    const index = turns.findIndex(t => samePosition(t.position, at) || t.versions?.some(p => samePosition(p, at)));
    if (index < 0) fail('POSITION_UNSUPPORTED');
    return index;
  }
  private attachments(ids: string[], accountId: string): Attachment[] {
    return ids.map(id => { const file = this.store.get<FileRef & { attachment: Attachment }>('files', id); if (!file || file.accountId !== accountId) fail('FILE_NOT_ACCESSIBLE', 400); return file.attachment; });
  }
  async upload(bytes: Uint8Array, name: string, accountId = 'default', key: string = randomUUID()): Promise<FileRef> {
    if (bytes.length > MAX_FILE_BYTES) fail('FILE_TOO_LARGE', 413);
    if (!bytes.length || typeof name !== 'string' || !name || name.length > 200 || /[\\/\x00-\x1f]/.test(name)) fail('INVALID_FILE', 400);
    const payload = { accountId, name, hash: createHash('sha256').update(bytes).digest('hex') };
    return this.locked('upload:' + accountId, async () => {
      const old = this.replay('upload', key, payload); if (old) return old;
      await this.backend.capabilities(accountId);
      this.remember('upload', key, payload, { kind: 'operation', signature: '', status: 'pending' });
      try {
        const attachment = await this.backend.upload(bytes, name, accountId);
        if (this.closed) fail('SERVICE_CLOSED', 503);
        const file = { id: randomUUID(), name, size: bytes.length, accountId };
        this.store.transaction(() => { this.store.put('files', file.id, { ...file, attachment }); this.remember('upload', key, payload, { kind: 'value', signature: '', value: file }); });
        return file;
      } catch { if (this.closed) fail('SERVICE_CLOSED', 503); this.remember('upload', key, payload, { kind: 'operation', signature: '', status: 'uncertain' }); throw new ApiError('OPERATION_UNCERTAIN', 'Upload outcome is unknown'); }
    });
  }
  private asTurn(chatId: string, turn: TurnData): Turn {
    const accountId = this.chat(chatId).accountId;
    const files = turn.input.files.map(attachment => {
      const existing = this.store.list<FileRef & { attachment: Attachment }>('files').find(f => f.accountId === accountId && canonical(f.attachment.reference) === canonical(attachment.reference));
      if (existing) { const { attachment: privateReference, ...info } = existing; return info; }
      const file: FileRef = { id: randomUUID(), accountId, name: attachment.name, size: attachment.size };
      this.store.put('files', file.id, { ...file, attachment }); return file;
    });
    return { ...turn, input: { text: turn.input.text, files }, chatId, id: createHash('sha256').update(canonical(turn.position)).digest('hex') };
  }
  async history(id: string, cursor?: string, limit = 20) {
    const chat = this.chat(id);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_INPUT', 400);
    const turns = this.decorate(id, this.project(chat, chat.upstream ? await this.backend.history(chat.upstream.cid, chat.accountId) : []));
    const fingerprint = createHash('sha256').update(canonical(turns.map(t => t.position))).digest('hex').slice(0, 16);
    let offset = 0;
    if (cursor) { const match = /^([a-f0-9]{16}):(\d+)$/.exec(cursor); if (!match || match[1] !== fingerprint) fail('HISTORY_CHANGED'); offset = Number(match[2]); }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > turns.length) fail('INVALID_CURSOR', 400);
    return { turns: turns.slice(offset, offset + limit).map(t => this.asTurn(id, t)), nextCursor: offset + limit < turns.length ? `${fingerprint}:${offset + limit}` : null };
  }
  async send(id: string, input: Input, key: string, revision: number): Promise<RunInfo> {
    const parsed = validate(inputSchema, input);
    return this.locked(id, async () => {
      const scope = `send:${id}`, old = this.replay(scope, key, parsed); if (old) return old;
      const chat = this.chat(id), turns = await this.check(chat, revision);
      const caps = await this.backend.capabilities(chat.accountId); if (!caps.send) fail('CAPABILITY_UNAVAILABLE');
      return this.start(chat, 'send', { text: parsed.text, files: this.attachments(parsed.files ?? [], chat.accountId) }, turns, undefined, scope, key, parsed);
    });
  }
  private start(chat: ChatRecord, operation: RunInfo['operation'], input: Generation['input'], turns: TurnData[], at: Position | undefined, scope: string, key: string, payload: unknown): RunInfo {
    const id = randomUUID();
    const index = at ? this.find(chat, at, turns) : turns.length;
    const generation: Generation = {
      id, accountId: chat.accountId, model: chat.model, operation, cid: chat.upstream?.cid, at,
      parent: operation === 'send' ? chat.head : turns[index - 1]?.position, input, baseline: turns.map(t => t.position),
    };
    const run: RunRecord = { id, chatId: chat.id, status: 'running', operation, base: generation.parent, generation };
    this.store.transaction(() => {
      chat.busy = id; chat.revision++; this.store.put('chats', chat.id, chat); this.store.put('runs', id, run);
      this.remember(scope, key, payload, { kind: 'run', id, signature: '' }); this.store.event(id, 'run.started');
    });
    void this.execute(run);
    return this.getRun(id);
  }
  private async execute(run: RunRecord) {
    try {
      const turn = await this.backend.generate(run.generation, event => {
        if (this.closed) return;
        if (event.type === 'position') { run = this.store.get<RunRecord>('runs', run.id)!; run.observed = event.position; this.store.put('runs', run.id, run); }
        else this.store.event(run.id, event.type, { delta: event.delta });
      });
      if (!this.closed) this.finish(run, turn);
    } catch (error) {
      if (this.closed) return;
      run = this.store.get<RunRecord>('runs', run.id)!;
      run.status = error instanceof ApiError && error.code === 'GENERATION_REJECTED' ? 'failed' : 'uncertain';
      run.error = { code: error instanceof ApiError ? error.code : 'UPSTREAM_UNCERTAIN', message: error instanceof ApiError ? error.message : 'Upstream outcome is unknown; generation was not repeated' };
      this.store.transaction(() => {
        this.store.put('runs', run.id, run); this.store.event(run.id, `run.${run.status}`, { error: run.error });
        if (run.status === 'failed') { const chat = this.chat(run.chatId); delete chat.busy; chat.revision++; this.store.put('chats', chat.id, chat); }
      });
    }
  }
  private finish(run: RunRecord, turn: TurnData) {
    if (this.store.list<{ runId: string; status: string }>('toolCalls').some(c => c.runId === run.id && c.status !== 'completed')) throw new ApiError('EXECUTION_UNCERTAIN', 'Tool execution must be reconciled before completion');
    const chat = this.chat(run.chatId);
    if (chat.busy !== run.id) fail('CHAT_CHANGED');
    run.status = 'completed'; run.turn = this.asTurn(chat.id, turn); delete run.error;
    chat.upstream = { cid: turn.position.cid }; chat.head = turn.position; chat.observedHead = turn.position; delete chat.busy; chat.revision++;
    this.store.transaction(() => {
      if (run.operation === 'regenerate' && run.generation.at) {
        const old = this.store.list<{ id: string; chatId: string; positions: Position[] }>('versions').find(g => g.chatId === chat.id && g.positions.some(p => samePosition(p, run.generation.at)));
        const group = old ?? { id: randomUUID(), chatId: chat.id, positions: [run.generation.at] };
        if (!group.positions.some(p => samePosition(p, turn.position))) group.positions.push(turn.position);
        this.store.put('versions', group.id, group); run.turn!.versions = group.positions;
      }
      this.store.put('runs', run.id, run); this.store.put('chats', chat.id, chat); this.store.event(run.id, 'run.completed', { result: run.turn });
    });
  }
  async refresh(id: string): Promise<RunInfo> {
    const info = this.getRun(id);
    return this.locked(info.chatId, async () => {
      const run = this.store.get<RunRecord>('runs', id)!;
      if (run.status !== 'uncertain') return this.getRun(id);
      const turn = await this.backend.recover(run.generation, run.observed);
      if (turn) this.finish(run, turn);
      return this.getRun(id);
    });
  }
  async fork(id: string, options: ForkInput, key: string, revision: number): Promise<ForkResult> {
    const parsed = validate(forkSchema, options);
    const payload = { ...parsed, mode: parsed.mode ?? 'new-chat' };
    return this.locked(id, async () => {
      const scope = `fork:${id}`, old = this.replay(scope, key, payload);
      if (old) return old.id ? { mode: 'in-place', chat: this.getChat(id), run: old } : old;
      const chat = this.chat(id), turns = await this.check(chat, revision);
      if (!(await this.backend.capabilities(chat.accountId)).fork) fail('CAPABILITY_UNAVAILABLE');
      const index = this.find(chat, parsed.at, turns);
      if (parsed.mode === 'in-place') {
        const run = this.start(chat, 'fork-in-place', { text: parsed.input.text, files: turns[index].input.files }, turns, parsed.at, scope, key, payload);
        return { mode: 'in-place', chat: this.getChat(id), run };
      }
      // Persist the claim before the upstream clone; a lost response must not clone twice.
      this.remember(scope, key, payload, { kind: 'operation', signature: '', status: 'pending' });
      try {
        const branch = await this.backend.fork(parsed.at, chat.accountId);
        if (this.closed) fail('SERVICE_CLOSED', 503);
        const result: ForkResult = { mode: 'new-chat', run: null, chat: {
          id: randomUUID(), accountId: chat.accountId, model: chat.model, revision: 0,
          upstream: { cid: branch.cid }, head: branch.turns.at(-1)?.position,
          source: { chatId: chat.id, at: parsed.at }, toolBinding: 'unverified',
        } };
        this.store.transaction(() => { this.store.put('chats', result.chat.id, result.chat); this.remember(scope, key, payload, { kind: 'value', signature: '', value: result }); });
        return result;
      } catch { if (this.closed) fail('SERVICE_CLOSED', 503); this.remember(scope, key, payload, { kind: 'operation', signature: '', status: 'uncertain' }); throw new ApiError('OPERATION_UNCERTAIN', 'Fork outcome is unknown; the operation will not be repeated'); }
    });
  }
  async regenerate(id: string, at: Position, key: string, revision: number) {
    validate(positionSchema, at);
    return this.locked(id, async () => {
      const scope = `regenerate:${id}`, old = this.replay(scope, key, at); if (old) return old;
      const chat = this.chat(id), turns = await this.check(chat, revision);
      if (!(await this.backend.capabilities(chat.accountId)).regenerate) fail('CAPABILITY_UNAVAILABLE');
      const index = this.find(chat, at, turns);
      if (index !== turns.length - 1) fail('POSITION_UNSUPPORTED');
      return this.start(chat, 'regenerate', turns[index].input, turns, at, scope, key, at);
    });
  }
  async select(id: string, at: Position, key: string, revision: number) {
    validate(positionSchema, at);
    return this.locked(id, async () => {
      const scope = `select:${id}`, old = this.replay(scope, key, at); if (old) return old;
      const chat = this.chat(id), turns = await this.check(chat, revision);
      if (!(await this.backend.capabilities(chat.accountId)).select) fail('CAPABILITY_UNAVAILABLE');
      const last = turns.at(-1);
      if (!last || at.cid !== chat.upstream?.cid || ![last.position, ...(last.versions ?? [])].some(p => samePosition(p, at))) fail('POSITION_UNSUPPORTED');
      this.remember(scope, key, at, { kind: 'operation', signature: '', status: 'pending' });
      try { await this.backend.select(at, chat.accountId); }
      catch { this.remember(scope, key, at, { kind: 'operation', signature: '', status: 'uncertain' }); throw new ApiError('OPERATION_UNCERTAIN'); }
      chat.head = at;
      chat.observedHead = (await this.backend.history(at.cid, chat.accountId)).at(-1)?.position;
      chat.revision++;
      this.store.transaction(() => { this.store.put('chats', id, chat); this.remember(scope, key, at, { kind: 'value', signature: '', value: this.getChat(id) }); });
      return this.getChat(id);
    });
  }
  close() { if (this.closed) return; this.closed = true; this.store.close(); }
}
