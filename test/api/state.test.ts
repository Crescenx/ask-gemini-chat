import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiService } from '../../src/api/service.ts';
import { ApiError } from '../../src/api/types.ts';
import { Remote, turn, until } from './helpers.ts';

async function setup(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'webchat-api-'));
  const backend = new Remote();
  const database = join(dir, 'state.sqlite');
  let service = new ApiService({ database, backend });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  return { backend, database, get service() { return service; }, restart() { service.close(); service = new ApiService({ database, backend }); return service; } };
}

test('explicit upload rejection preserves its upstream status across retries and restart', async t => {
  const x = await setup(t); let uploads = 0;
  x.backend.upload = async () => { uploads++; throw new ApiError('UPLOAD_REJECTED', 'Upstream upload HTTP 413', 413); };
  const check = () => assert.rejects(x.service.upload(Buffer.from('fixture'), 'file.txt', 'default', 'same'), { code: 'UPLOAD_REJECTED', status: 413, message: 'Upstream upload HTTP 413' });
  await check(); await check(); x.restart(); await check(); assert.equal(uploads, 1);
});

test('uncertain upload preserves a safe cause across retries and restart without resubmitting', async t => {
  const x = await setup(t); let uploads = 0;
  for (const cause of ['HTTP_TRANSPORT_ERROR', 'LOGIN_REQUIRED', 'private path or credential','PROXY_CONNECT_FAILED']) {
    const proxyError=cause==='PROXY_CONNECT_FAILED'?{code:cause,endpoint:'http://127.0.0.1:43210',source:'fixture',curlCode:7}:undefined;
    x.backend.upload = async () => { uploads++; throw Object.assign(Error(cause),{proxyError}); };
    const message = `Upload outcome is unknown (${cause.includes(' ') ? 'UPLOAD_FAILED' : cause})`;
    const check = () => assert.rejects(x.service.upload(Buffer.from('fixture'), 'file.docx', 'default', cause), error=>{
      assert.equal((error as ApiError).code,'OPERATION_UNCERTAIN');assert.equal((error as Error).message,message);
      assert.deepEqual((error as ApiError).proxyError,proxyError);return true;
    });
    await check(); await check(); x.restart(); await check();
  }
  assert.equal(uploads, 4);
});

test('concurrent duplicate send is one remote generation; key conflict and stale revision are distinct', async t => {
  const x = await setup(t);
  const chat = await x.service.createChat({ model: 'argon' }, 'create');
  let release!: () => void;
  x.backend.gate = new Promise<void>(r => { release = r; });
  const [a, b] = await Promise.all([
    x.service.send(chat.id, { text: 'one' }, 'send', chat.revision),
    x.service.send(chat.id, { text: 'one' }, 'send', chat.revision),
  ]);
  assert.equal(a.id, b.id);
  await until(() => x.backend.generations.length === 1);
  await assert.rejects(x.service.send(chat.id, { text: 'different' }, 'send', chat.revision), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(x.service.send(chat.id, { text: 'two' }, 'another', x.service.getChat(chat.id).revision), { code: 'CHAT_BUSY' });
  release();
  await until(() => x.service.getRun(a.id).status === 'completed');
  // A lost HTTP reply can be retried with the original revision, even after completion.
  assert.equal((await x.service.send(chat.id, { text: 'one' }, 'send', chat.revision)).id, a.id);
  await assert.rejects(x.service.send(chat.id, { text: 'two' }, 'new', chat.revision), { code: 'CHAT_CHANGED' });
  assert.equal(x.backend.generations.length, 1);
});

test('process restart preserves pending identity and never replays an uncertain generation', async t => {
  const x = await setup(t);
  const chat = await x.service.createChat({ model: 'argon' }, 'create');
  let release!: () => void;
  x.backend.gate = new Promise<void>(r => { release = r; });
  const run = await x.service.send(chat.id, { text: 'side effect unknown' }, 'send', chat.revision);
  await until(() => x.backend.generations.length === 1);
  x.restart();
  assert.equal(x.service.getRun(run.id).status, 'uncertain');
  const same = await x.service.send(chat.id, { text: 'side effect unknown' }, 'send', chat.revision);
  assert.equal(same.id, run.id);
  await x.service.refresh(run.id);
  assert.equal(x.backend.generations.length, 1);
  release();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(x.service.getRun(run.id).status, 'uncertain');
});

test('lost transport after upstream completion recovers exact observed turn without a second send', async t => {
  const x = await setup(t);
  x.backend.failAfterWrite = true;
  const chat = await x.service.createChat({ model: 'argon' }, 'create');
  const run = await x.service.send(chat.id, { text: 'done remotely' }, 'send', chat.revision);
  await until(() => x.service.getRun(run.id).status === 'uncertain');
  x.restart();
  const recovered = await x.service.refresh(run.id);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.turn?.output.text, 'reply:done remotely');
  assert.equal(x.backend.generations.length, 1);
  assert(x.service.events(run.id, 0).some(e => e.type === 'run.uncertain'));
  assert(x.service.events(run.id, 0).some(e => e.type === 'run.completed'));
});

test('corrected partial snapshots survive restart and are cleared only on verified completion',async t=>{
  const x=await setup(t);
  let calls=0;
  x.backend.generate=async(input,observe)=>{
    calls++;const result=turn('c_abcd',1,input.input.text);
    x.backend.paths.set('c_abcd',[result]);
    observe({type:'position',position:result.position});
    observe({type:'text.delta',delta:'wrong'});observe({type:'text.replace',text:'corrected partial'});
    throw Error('transport broke');
  };
  const chat=await x.service.createChat({model:'argon'},'create');
  const r=await x.service.send(chat.id,{text:'fixture'},'send',chat.revision);
  await until(()=>x.service.getRun(r.id).status==='uncertain');
  x.restart();assert.equal(x.service.getRun(r.id).partial?.text,'corrected partial');
  const recovered=await x.service.refresh(r.id);
  assert.equal(recovered.status,'completed');assert.equal(recovered.partial,undefined);
  assert.equal(recovered.turn?.output.text,'reply:fixture');assert.equal(calls,1);
});

test('temporary saved results and context survive restart without upstream history', async t => {
  const x = await setup(t);
  x.backend.history = async () => { assert.fail('no upstream history for temporary chats'); };
  x.backend.recover = async () => { assert.fail('no upstream recovery for temporary chats'); };
  const chat = await x.service.createChat({ model: 'argon', temporary: true }, 'create-temp');
  const first = await x.service.send(chat.id, { text: 'remember' }, 'first', chat.revision);
  await until(() => x.service.getRun(first.id).status === 'completed');
  const position = x.service.getRun(first.id).turn!.position;
  x.restart();
  assert.equal(x.service.getChat(chat.id).temporary, true);
  assert.equal((await x.service.refresh(first.id)).turn?.output.text, 'reply:remember');
  assert.equal((await x.service.send(chat.id, { text: 'remember' }, 'first', 0)).id, first.id);
  const revision = x.service.getChat(chat.id).revision;
  const second = await x.service.send(chat.id, { text: 'recall' }, 'second', revision);
  await until(() => x.service.getRun(second.id).status === 'completed');
  assert.deepEqual(x.backend.generations[1].parent, position);
  assert.equal(x.backend.generations[1].temporary, true);
  const page = await x.service.history(chat.id, undefined, 1);
  assert.equal(page.turns[0].input.text, 'remember');
  assert.equal((await x.service.history(chat.id, page.nextCursor!, 1)).turns[0].input.text, 'recall');
  const head = x.service.getChat(chat.id).head!, current = x.service.getChat(chat.id).revision;
  await assert.rejects(x.service.fork(chat.id, { at: head }, 'fork-temp', current), { code: 'CAPABILITY_UNAVAILABLE' });
  await assert.rejects(x.service.fork(chat.id, { mode: 'in-place', at: head, input: { text: 'edit' } }, 'edit-temp', current), { code: 'CAPABILITY_UNAVAILABLE' });
  await assert.rejects(x.service.regenerate(chat.id, head, 'regen-temp', current), { code: 'CAPABILITY_UNAVAILABLE' });
  await assert.rejects(x.service.select(chat.id, head, 'select-temp', current), { code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(x.backend.generations.length, 2); assert.equal(x.backend.forks, 0);
});

test('interrupted temporary requests stay uncertain across restart and are never recovered or resent', async t => {
  const x = await setup(t);
  x.backend.recover = async () => { assert.fail('temporary recovery must not run'); };
  let release!: () => void;
  x.backend.gate = new Promise<void>(r => { release = r; });
  const chat = await x.service.createChat({ model: 'argon', temporary: true }, 'temp-create');
  const run = await x.service.send(chat.id, { text: 'unknown' }, 'temp-send', chat.revision);
  await until(() => x.backend.generations.length === 1);
  x.restart();
  const interrupted = await x.service.refresh(run.id);
  assert.equal(interrupted.status, 'uncertain');
  assert.equal(interrupted.error?.code, 'TEMPORARY_RESULT_UNRECOVERABLE');
  assert.equal((await x.service.send(chat.id, { text: 'unknown' }, 'temp-send', 0)).id, run.id);
  await assert.rejects(x.service.send(chat.id, { text: 'next' }, 'temp-next', x.service.getChat(chat.id).revision), { code: 'CHAT_BUSY' });
  release(); await new Promise(r => setTimeout(r, 20));
  assert.equal((await x.service.refresh(run.id)).status, 'uncertain');
  assert.equal(x.backend.generations.length, 1);
});

test('explicit normal mode preserves existing creation idempotency signatures', async t => {
  const x = await setup(t);
  const original = await x.service.createChat({ model: 'argon' }, 'existing-create');
  x.restart();
  assert.equal((await x.service.createChat({ model: 'argon', temporary: false }, 'existing-create')).id, original.id);
  await assert.rejects(x.service.createChat({ model: 'argon', temporary: true }, 'existing-create'), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('fork at interior reply copies prefix to new cid; in-place replacement retains files and cuts descendants', async t => {
  const x = await setup(t);
  const cid = 'c_abcd';
  const files = [{ name: 'image.png', reference: 'fixture:image', size: 20 }];
  x.backend.paths.set(cid, [turn(cid, 1, 'first'), turn(cid, 2, 'image question', files), turn(cid, 3, 'last')]);
  const source = await x.service.attach({ accountId: 'default', upstream: { cid } }, 'attach');
  const at = x.backend.paths.get(cid)![1].position;
  const forked = await x.service.fork(source.id, { mode: 'new-chat', at }, 'fork', source.revision);
  assert.equal(forked.mode, 'new-chat');
  assert.equal(forked.run, null);
  assert.notEqual(forked.chat.upstream?.cid, cid);
  assert.equal((await x.service.history(forked.chat.id)).turns.length, 2);
  assert.equal((await x.service.history(source.id)).turns.length, 3);
  assert.deepEqual(forked.chat.source?.at, at);
  const target = forked.chat.head!;
  assert.notEqual(target.rid, at.rid);
  const replaced = await x.service.fork(forked.chat.id, { mode: 'in-place', at: target, input: { text: 'new image question' } }, 'replace', forked.chat.revision);
  await until(() => x.service.getRun(replaced.run!.id).status === 'completed');
  assert.deepEqual(x.backend.generations[0].input.files, files);
  assert.equal(x.backend.generations[0].operation, 'fork-in-place');
  assert.equal((await x.service.history(source.id)).turns.length, 3);
  assert.equal((await x.service.history(forked.chat.id)).turns.length, 2);
  // A response lost after fork must not allocate another remote conversation.
  x.restart();
  const repeated = await x.service.fork(source.id, { mode: 'new-chat', at }, 'fork', source.revision);
  assert.equal(repeated.chat.id, forked.chat.id);
  assert.equal(x.backend.forks, 1);
});

test('reject cross-chat positions, replacement attachments, unknown models and native MCP before side effects', async t => {
  const x = await setup(t);
  await assert.rejects(x.service.createChat({ model: 'wrong' }, 'wrong'), { code: 'MODEL_UNAVAILABLE' });
  await assert.rejects(x.service.createChat({ model: 'argon', tools: { toolset: 'local' } }, 'tools'), { code: 'CAPABILITY_UNAVAILABLE' });
  const cid = 'c_aaaa';
  x.backend.paths.set(cid, [turn(cid, 1, 'first')]);
  const chat = await x.service.attach({ upstream: { cid } }, 'attach');
  await assert.rejects(x.service.fork(chat.id, { mode: 'new-chat', at: { ...chat.head!, cid: 'c_bbbb' } }, 'cross', chat.revision), { code: 'POSITION_UNSUPPORTED' });
  await assert.rejects(x.service.fork(chat.id, { mode: 'in-place', at: chat.head!, input: { text: 'x', files: [] } } as any, 'files', chat.revision), { code: 'INVALID_INPUT' });
  assert.equal(x.backend.generations.length, 0);
  assert.equal(x.backend.forks, 0);
});

test('external webpage head drift is detected before any mutating request', async t => {
  const x = await setup(t);
  const cid = 'c_aaaa';
  x.backend.paths.set(cid, [turn(cid, 1, 'first')]);
  const chat = await x.service.attach({ upstream: { cid } }, 'attach');
  x.backend.paths.get(cid)!.push(turn(cid, 2, 'changed in browser'));
  await assert.rejects(x.service.send(chat.id, { text: 'wrong base' }, 'send', chat.revision), { code: 'CHAT_CHANGED' });
  assert.equal(x.backend.generations.length, 0);
  const synced = await x.service.attach({ upstream: { cid } }, 'resync');
  assert.equal(synced.id, chat.id);
  assert.equal(synced.head?.rid, 'r_2');
  assert.equal(synced.revision, chat.revision + 1);
});

test('upstream completion cannot erase an unresolved local tool execution', async t => {
  const x = await setup(t);
  let release!: () => void;
  x.backend.gate = new Promise<void>(r => { release = r; });
  const chat = await x.service.createChat({ model: 'argon' }, 'create');
  const run = await x.service.send(chat.id, { text: 'tool task' }, 'send', chat.revision);
  x.service.store.put('toolCalls', 'claimed', { id: 'claimed', runId: run.id, status: 'uncertain' });
  const stored = x.service.store.get('runs', run.id)!;
  x.service.store.put('runs', run.id, { ...stored, status: 'uncertain', error: { code: 'EXECUTION_UNCERTAIN' } });
  release();
  await until(() => x.service.events(run.id, 0).some(e => e.type === 'run.uncertain'));
  assert.equal(x.service.getRun(run.id).status, 'uncertain');
  assert.equal(x.service.getRun(run.id).error?.code, 'EXECUTION_UNCERTAIN');
  assert(!x.service.events(run.id, 0).some(e => e.type === 'run.completed'));
});

test('shutdown during remote fork preserves uncertain claim and never forks twice', async t => {
  const x = await setup(t), cid = 'c_aaaa';
  x.backend.paths.set(cid, [turn(cid, 1, 'first')]);
  const chat = await x.service.attach({ upstream: { cid } }, 'attach');
  const original = x.backend.fork.bind(x.backend);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  x.backend.fork = async at => { const result = await original(at); await gate; return result; };
  const pending = x.service.fork(chat.id, { at: chat.head! }, 'fork', chat.revision);
  await until(() => x.backend.forks === 1);
  x.service.close(); release();
  await assert.rejects(pending, { code: 'SERVICE_CLOSED' });
  x.restart();
  await assert.rejects(x.service.fork(chat.id, { at: chat.head! }, 'fork', chat.revision), { code: 'OPERATION_UNCERTAIN' });
  assert.equal(x.backend.forks, 1);
});

test('SSE replay uses durable monotonic IDs and returns only events after cursor across restart', async t => {
  const x = await setup(t);
  const chat = await x.service.createChat({ model: 'argon' }, 'create');
  const run = await x.service.send(chat.id, { text: 'stream' }, 'send', chat.revision);
  await until(() => x.service.getRun(run.id).status === 'completed');
  const events = x.service.events(run.id, 0);
  assert(events.some(e => e.type === 'text.delta'));
  x.restart();
  assert.deepEqual(x.service.events(run.id, events[0].id), events.slice(1));
  assert.equal(new Set(events.map(e => e.id)).size, events.length);
});

test('regenerated versions have different rids and remain selectable after restart', async t => {
  const x = await setup(t);
  const chat = await x.service.createChat({ model: 'argon' }, 'create');
  const first = await x.service.send(chat.id, { text: 'question' }, 'send', chat.revision);
  await until(() => x.service.getRun(first.id).status === 'completed');
  const original = x.service.getRun(first.id).turn!;
  const retried = await x.service.regenerate(chat.id, original.position, 'retry', x.service.getChat(chat.id).revision);
  await until(() => x.service.getRun(retried.id).status === 'completed');
  assert.notEqual(x.service.getRun(retried.id).turn!.position.rid, original.position.rid);
  x.restart();
  await x.service.select(chat.id, original.position, 'select', x.service.getChat(chat.id).revision);
  assert.deepEqual(x.service.getChat(chat.id).head, original.position);
  assert.equal(x.backend.generations.length, 2);
});

test('selected context is distinct from latest generated history; drift checks still detect outside changes', async t => {
  const x = await setup(t); x.backend.selectionChangesHistory = false;
  const chat = await x.service.createChat({ model: 'argon' }, 'create');
  const first = await x.service.send(chat.id, { text: 'question' }, 'send', chat.revision);
  await until(() => x.service.getRun(first.id).status === 'completed');
  const original = x.service.getRun(first.id).turn!;
  const retry = await x.service.regenerate(chat.id, original.position, 'retry', x.service.getChat(chat.id).revision);
  await until(() => x.service.getRun(retry.id).status === 'completed');
  await x.service.select(chat.id, original.position, 'select', x.service.getChat(chat.id).revision);
  assert.deepEqual((await x.service.history(chat.id)).turns.at(-1)!.position, original.position);
  x.restart();
  const cid = x.service.getChat(chat.id).upstream!.cid;
  x.backend.paths.get(cid)!.push(turn(cid, 999, 'outside change'));
  await assert.rejects(x.service.send(chat.id, { text: 'next' }, 'next', x.service.getChat(chat.id).revision), { code: 'CHAT_CHANGED' });
});
