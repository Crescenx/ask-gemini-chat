import { randomUUID } from 'node:crypto';
import type { Backend, BackendChat, Generation, Position, TurnData, UploadSource } from '../../src/api/types.ts';

export const position = (cid: string, n: number): Position => ({ cid, rid: `r_${n.toString(16)}`, rcid: `rc_${n.toString(16)}` });
export const turn = (cid: string, n: number, text: string, files: unknown[] = []): TurnData => ({
  position: position(cid, n), input: { text, files: files as any }, output: { text: `reply:${text}` },
});

// This fixture models remote state independently from API storage; its history can
// change externally, and a generation can finish remotely after its caller dies.
export class Remote implements Backend {
  paths = new Map<string, TurnData[]>();
  generations: Generation[] = [];
  forks = 0;
  sequence = 100;
  gate?: Promise<void>;
  failAfterWrite = false;
  tools = false;
  selectionChangesHistory = true;
  archived = new Map<string, TurnData>();
  async capabilities() { return { models: ['argon'], send: true, fork: true, regenerate: true, select: true, nativeMcp: this.tools }; }
  async history(cid: string) { return structuredClone(this.paths.get(cid) ?? []); }
  async upload(bytes: UploadSource, name: string) { return { name, reference: `fixture:${randomUUID()}`, size: bytes instanceof Uint8Array ? bytes.length : bytes.size }; }
  async generate(input: Generation, observe: (event: any) => void) {
    this.generations.push(structuredClone(input));
    await this.gate;
    const cid = input.cid ?? `c_${(++this.sequence).toString(16)}`;
    let path = this.paths.get(cid) ?? [];
    for (const t of path) this.archived.set(t.position.rid, structuredClone(t));
    if (input.operation !== 'send') {
      const index = path.findIndex(t => t.position.rid === input.at?.rid);
      if (index < 0) throw Error('fixture target missing');
      path = path.slice(0, index);
    }
    const result = turn(cid, ++this.sequence, input.input.text, input.input.files);
    this.paths.set(cid, [...path, result]);
    this.archived.set(result.position.rid, structuredClone(result));
    observe({ type: 'position', position: result.position });
    if (this.failAfterWrite) throw Error('connection lost after upstream commit');
    observe({ type: 'text.delta', delta: result.output.text });
    return structuredClone(result);
  }
  async fork(at: Position): Promise<BackendChat> {
    this.forks++;
    const source = this.paths.get(at.cid)!;
    const index = source.findIndex(t => t.position.rid === at.rid);
    const cid = `c_${(++this.sequence).toString(16)}`;
    const path = source.slice(0, index + 1).map(t => ({ ...structuredClone(t), position: position(cid, ++this.sequence) }));
    this.paths.set(cid, path);
    return { cid, turns: structuredClone(path) };
  }
  async select(at: Position) {
    const path = this.paths.get(at.cid)!;
    const target = this.archived.get(at.rid) ?? path.find(t => t.position.rid === at.rid);
    if (!target) throw Error('fixture unknown version');
    if (this.selectionChangesHistory) this.paths.set(at.cid, [...path.slice(0, -1), structuredClone(target)]);
  }
  async recover(input: Generation, observed?: Position) {
    if (!observed) return null;
    const path = this.paths.get(observed.cid) ?? [];
    const found = path.find(t => t.position.rid === observed.rid && t.input.text === input.input.text);
    return found ? structuredClone(found) : null;
  }
}

export async function until(check: () => boolean | Promise<boolean>) {
  const start = Date.now();
  while (!await check()) {
    if (Date.now() - start > 3000) throw Error('test condition timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}
