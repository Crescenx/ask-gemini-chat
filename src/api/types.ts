export type Position = { cid: string; rid: string; rcid: string };
export type Attachment = { name: string; reference: unknown; size?: number };
export type FileRef = { id: string; name: string; size?: number; accountId: string };
export type TurnData = {
  position: Position;
  input: { text: string; files: Attachment[] };
  output: { text: string; thoughts?: string };
  versions?: Position[];
};
export type Turn = Omit<TurnData, 'input'> & { id: string; chatId: string; input: { text: string; files: FileRef[] } };
export type ChatInfo = {
  id: string; accountId: string; model: string; revision: number;
  temporary?: boolean;
  upstream?: { cid: string }; head?: Position;
  source?: { chatId: string; at: Position };
  toolBinding: 'none' | 'unverified' | 'ready';
};
export type RunInfo = {
  id: string; chatId: string;
  temporary?: boolean;
  status: 'running' | 'waiting_tool' | 'completed' | 'failed' | 'uncertain';
  operation: 'send' | 'fork-in-place' | 'regenerate';
  base?: Position; turn?: Turn;
  error?: { code: string; message: string };
};
export type RunEvent = { id: number; runId: string; type: string; at: string; [key: string]: unknown };
export type Input = { text: string; files?: string[] };
export type CreateChat = { accountId?: string; model: string; temporary?: boolean; tools?: { toolset: string } };
export type AttachChat = { accountId?: string; upstream: { cid: string } };
export type ForkInput =
  | { mode?: 'new-chat'; at: Position }
  | { mode: 'in-place'; at: Position; input: { text: string } };
export type ForkResult =
  | { mode: 'new-chat'; chat: ChatInfo; run: null }
  | { mode: 'in-place'; chat: ChatInfo; run: RunInfo };
export type Capabilities = { models: string[]; send: boolean; fork: boolean; regenerate: boolean; select: boolean; nativeMcp: boolean };
export type Generation = {
  id: string; accountId: string; model: string; cid?: string;
  temporary?: boolean;
  operation: RunInfo['operation']; at?: Position; parent?: Position;
  input: { text: string; files: Attachment[] };
  baseline: Position[];
};
export type Observation = { type: 'position'; position: Position } | { type: 'text.delta' | 'thinking.delta'; delta: string };
export type BackendChat = { cid: string; turns: TurnData[] };
export interface Backend {
  capabilities(accountId?: string): Promise<Capabilities>;
  history(cid: string, accountId?: string): Promise<TurnData[]>;
  upload(bytes: Uint8Array, name: string, accountId?: string): Promise<Attachment>;
  generate(input: Generation, observe: (event: Observation) => void): Promise<TurnData>;
  fork(at: Position, accountId?: string): Promise<BackendChat>;
  select(at: Position, accountId?: string): Promise<void>;
  recover(input: Generation, observed?: Position): Promise<TurnData | null>;
}

export class ApiError extends Error {
  code: string;
  status: number;
  runId?: string;
  constructor(code: string, message = code, status = 409, runId?: string) {
    super(message); this.name = 'ApiError'; this.code = code; this.status = status; this.runId = runId;
  }
}
export function fail(code: string, status = 409): never { throw new ApiError(code, code, status); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(v => canonical(v ?? null)).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export const samePosition = (a?: Position, b?: Position) => canonical(a) === canonical(b);
