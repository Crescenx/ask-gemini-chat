import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeBackend } from '../../src/api/native.ts';
import type { Generation, Observation } from '../../src/api/types.ts';

const candidate = (rcid: string, text: string, status = 2) => [rcid, [text], null, null, null, null, null, null, [status]];
const history = (rows: any[]) => JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([rows])]]) + '\n';
const row = (rid: string, text: string, answer: string, status = 2) => [['c_abcd', rid], null, [[text, 0, null, null]], [[candidate('rc_' + rid.slice(2), answer, status)], null, null, 'rc_' + rid.slice(2)]];
const generation = (rid: string, text: string) => JSON.stringify([['wrb.fr', null, JSON.stringify([null, ['c_abcd', rid], null, null, [candidate('rc_' + rid.slice(2), text)]])]]) + '\n';
const request: Generation = { id: 'req-1', accountId: 'default', model: 'argon', operation: 'fork-in-place', cid: 'c_abcd', at: { cid: 'c_abcd', rid: 'r_2', rcid: 'rc_2' }, parent: { cid: 'c_abcd', rid: 'r_1', rcid: 'rc_1' }, input: { text: 'replacement', files: [{ name: 'image.png', reference: [['/contrib_service/test'], 'image.png'] }] }, baseline: [{ cid: 'c_abcd', rid: 'r_1', rcid: 'rc_1' }, { cid: 'c_abcd', rid: 'r_2', rcid: 'rc_2' }] };

test('upload distinguishes explicit size rejection from an uncertain connection failure',async()=>{
  let error=Error('HTTP_413');
  const backend=new NativeBackend({api:{upload:async()=>{throw error;}} as any});
  await assert.rejects(backend.upload(Buffer.from('fixture'),'file.txt'),{code:'UPLOAD_REJECTED',status:413});
  error=Error('HTTP_TRANSPORT_ERROR');
  await assert.rejects(backend.upload(Buffer.from('fixture'),'file.txt'),{message:'HTTP_TRANSPORT_ERROR'});
});

test('native adapter passes edit flag, parent position and unchanged attachment; completion requires independent history', async () => {
  let submitted: any;
  const api = {
    start: async (input: any) => { submitted = input; return input.id; },
    poll: async () => ({ done: true, exhausted: true, status: 200, raw: generation('r_3', 'answer') }),
    history: async () => history([row('r_3', 'replacement', 'answer'), row('r_1', 'first', 'first answer')]),
  };
  const adapter = new NativeBackend({ api: api as any, pollMs: 1 });
  const events: Observation[] = [];
  const result = await adapter.generate(request, e => events.push(e));
  assert.deepEqual(submitted.metadata, ['c_abcd', 'r_1', 'rc_1']);
  assert.equal(submitted.operationFlag, 2);
  assert.deepEqual(submitted.files, [[['/contrib_service/test'], 'image.png']]);
  assert.equal(result.position.rid, 'r_3');
  assert(events.some(e => e.type === 'position'));
});

test('a complete-looking stream without matching server history remains uncertain', async () => {
  const api = { start: async () => 'req-1', poll: async () => ({ done: true, exhausted: true, status: 200, raw: generation('r_3', 'answer') }), history: async () => history([row('r_2', 'old', 'old answer'), row('r_1', 'first', 'first answer')]) };
  const adapter = new NativeBackend({ api: api as any, pollMs: 1 });
  await assert.rejects(adapter.generate(request, () => {}), { code: 'UPSTREAM_UNCERTAIN' });
});

test('a generation still running after two hours is awaited without resubmission', async t => {
  let now = 0, polls = 0, submissions = 0;
  t.mock.method(Date, 'now', () => now);
  const api = {
    start: async () => { submissions++; return request.id; },
    poll: async () => {
      if (++polls === 1) { now = 2 * 60 * 60 * 1000; return { done: false, raw: '' }; }
      return { done: true, exhausted: true, status: 200, raw: generation('r_3', 'answer') };
    },
    history: async () => history([row('r_3', 'replacement', 'answer'), row('r_1', 'first', 'first answer')]),
  };
  const result = await new NativeBackend({ api: api as any, pollMs: 1 }).generate(request, () => {});
  assert.equal(result.position.rid, 'r_3'); assert.equal(submissions, 1); assert.equal(polls, 2);
});

test('history paginates past 1000 turns and native completion releases transport snapshots', async()=>{
  const cursors:(string|null)[]=[];
  const adapter=new NativeBackend({api:{history:async(_cid:string,limit:number,cursor:string|null)=>{
    cursors.push(cursor);assert.equal(limit,20);
    const offset=cursor?Number(cursor):0, count=Math.min(limit,1300-offset);
    const rows=Array.from({length:count},(_,i)=>row('r_'+(1300-offset-i).toString(16),'question','answer'));
    return JSON.stringify([['wrb.fr','hNvQHb',JSON.stringify([rows,offset+count<1300?String(offset+count):null])]])+'\n';
  }} as any});
  const turns=await adapter.history('c_abcd');assert.equal(turns.length,1300);
  assert.equal(turns[0].position.rid,'r_1');assert.equal(turns.at(-1)!.position.rid,'r_514');
  assert.equal(cursors.length,65);assert.equal(cursors.at(-1),'1280');
  let released='';
  const backend=new NativeBackend({api:{start:async()=>request.id,poll:async()=>({done:true,error:'broken'}),release:(id:string)=>{released=id;}} as any});
  await assert.rejects(backend.generate(request,()=>{}));assert.equal(released,request.id);
});

test('history rejects repeated cursors and overlapping pages instead of looping or duplicating turns',async()=>{
  for(const overlap of [false,true]){
    let calls=0;
    const adapter=new NativeBackend({api:{history:async()=>{
      const rows=[row('r_'+(overlap?1:++calls),'question','answer')];
      return JSON.stringify([['wrb.fr','hNvQHb',JSON.stringify([rows,'same-cursor'])]])+'\n';
    }} as any});
    await assert.rejects(adapter.history('c_abcd'),{code:overlap?'UPSTREAM_HISTORY_CHANGED':'UPSTREAM_HISTORY_INVALID_CURSOR'});
  }
});

test('recovery rejects old identical text and incomplete upstream turn, instead of inventing success', async () => {
  let raw = history([row('r_2', 'replacement', 'old answer')]);
  const adapter = new NativeBackend({ api: { history: async () => raw } as any });
  assert.equal(await adapter.recover(request), null);
  raw = history([row('r_3', 'replacement', 'partial', 1)]);
  assert.equal(await adapter.recover(request, { cid: 'c_abcd', rid: 'r_3', rcid: 'rc_3' }), null);
});

test('authentication failure before upstream submission is a definitive rejection', async () => {
  const api = { start: async () => 'req-1', poll: async () => ({ done: true, stage: 'authentication', error: 'LOGIN_REQUIRED', raw: '' }) };
  const adapter = new NativeBackend({ api: api as any, pollMs: 1 });
  await assert.rejects(adapter.generate(request, () => {}), { code: 'GENERATION_REJECTED' });
});

test('explicit upstream precondition rejection exposes its code; an observed turn remains recoverable', async () => {
  const error = JSON.stringify([['wrb.fr', null, null, null, null, [9, null, [['type.googleapis.com/assistant.boq.bard.application.BardErrorInfo', [1060]]]]]]) + '\n';
  let raw = error;
  const api = { start: async () => request.id, poll: async () => ({ done: true, exhausted: true, raw }) };
  const adapter = new NativeBackend({ api: api as any });
  await assert.rejects(adapter.generate(request, () => {}), { code: 'GENERATION_REJECTED', message: 'Upstream RPC 9, BardErrorInfo 1060' });
  raw = generation('r_3', 'partial') + error;
  await assert.rejects(adapter.generate(request, () => {}), { code: 'UPSTREAM_UNCERTAIN', message: 'Upstream RPC 9, BardErrorInfo 1060' });
});

test('a disconnected preamble retains its exact turn ID for read-only recovery', async () => {
  let observed: any;
  const api = {
    start: async () => request.id,
    poll: async () => ({ done: true, error: 'TRANSPORT_ERROR', stage: 'generation', raw: JSON.stringify([['wrb.fr', null, JSON.stringify([null, ['c_abcd', 'r_3']])]]) + '\n' }),
    history: async () => history([row('r_3', 'replacement', 'late answer'), row('r_1', 'first', 'first answer')]),
  };
  const adapter = new NativeBackend({ api: api as any });
  await assert.rejects(adapter.generate(request, e => { if (e.type === 'position') observed = e.position; }), { code: 'UPSTREAM_UNCERTAIN' });
  assert.deepEqual(observed, { cid: 'c_abcd', rid: 'r_3', rcid: '' });
  assert.equal((await adapter.recover(request, observed))?.output.text, 'late answer');
  assert.equal(await adapter.recover(request, { ...observed, rid: 'r_2' }), null);
  assert.equal(await adapter.recover(request, { ...observed, rcid: 'rc_other' }), null);
  assert.equal(await adapter.recover({ ...request, input: { ...request.input, text: 'different' } }, observed), null);
});

test('temporary completion waits for stream exhaustion and preserves attachments without history', async () => {
  let submitted: any, polls = 0;
  const input: Generation = { ...request, operation: 'send', temporary: true };
  const api = {
    start: async (value: any) => { submitted = value; return value.id; },
    poll: async () => ({ done: ++polls > 1, exhausted: polls > 1, raw: generation('r_3', 'answer') }),
    history: async () => { throw Error('temporary history must not be queried'); },
  };
  const backend = new NativeBackend({ api: api as any, pollMs: 1 });
  const result = await backend.generate(input, () => {});
  assert.equal(polls, 2); assert.equal(submitted.temporary, true);
  assert.equal(submitted.operationFlag, undefined); assert.deepEqual(submitted.metadata, ['c_abcd', 'r_1', 'rc_1']);
  assert.deepEqual(result.input.files, input.input.files); assert.equal(result.output.text, 'answer');
  assert.equal(await backend.recover(input, result.position), null);
  await assert.rejects(backend.generate({ ...input, operation: 'regenerate' }, () => {}), { code: 'GENERATION_REJECTED' });
});

test('temporary streams reject interruption, incomplete, stale and mismatched results', async () => {
  const input: Generation = { ...request, operation: 'send', temporary: true };
  const raw = generation('r_3', 'answer');
  const partial = JSON.stringify([['wrb.fr', null, JSON.stringify([null, ['c_abcd', 'r_3'], null, null, [candidate('rc_3', 'partial', 1)]])]]) + '\n';
  const states = [
    { done: true, exhausted: false, raw },
    { done: true, exhausted: true, error: 'TRANSPORT_ERROR', raw },
    { done: true, exhausted: true, raw: partial },
    { done: true, exhausted: true, raw: raw + partial },
    { done: true, exhausted: true, raw: generation('r_2', 'stale') },
    { done: true, exhausted: true, raw: raw.replace('c_abcd', 'c_ffff') },
    { done: true, exhausted: true, raw: raw.replace('rc_3', '') },
  ];
  for (const state of states) {
    const api = { start: async () => input.id, poll: async () => state, history: async () => { assert.fail('must not query history'); } };
    await assert.rejects(new NativeBackend({ api: api as any }).generate(input, () => {}), { code: 'UPSTREAM_UNCERTAIN' });
  }
});

test('text replacements and original transport diagnostics survive an interrupted stream',async()=>{
  const texts=['[project](https://exa','[project](https://example.com)\n','[project](https://example.com)\nMore'];
  const transport={proxyEnvironment:{HTTPS_PROXY:'http://127.0.0.1:4290'},noProxyConfigured:false,elapsedMs:100,pythonException:'ConnectionError',curlCode:56,pythonElapsedMs:90,pythonStage:'body',transportId:'fixture-transport'};
  let index=0,text='';const events:Observation[]=[];
  const api={start:async()=>request.id,poll:async()=>{
    const i=Math.min(index++,texts.length-1);
    return {done:i===2,error:i===2?'RESPONSE_FRAME_SIZE_LIMIT':undefined,receivedChars:1010000,model:'95a4c0abcba24364',transportDiagnostics:transport,elapsedMs:150,status:200,
      response:{text:texts[i],metadata:['c_abcd','r_3','rc_3'],complete:false}};
  }};
  // A rewrite removes an earlier Markdown fragment, rather than only appending.
  texts[0]='[https://example.com](https://exa';
  await assert.rejects(new NativeBackend({api:api as any,pollMs:1}).generate(request,e=>{
    events.push(e);if(e.type==='text.delta')text+=e.delta;if(e.type==='text.replace')text=e.text;
  }),{code:'UPSTREAM_UNCERTAIN',message:'Generation did not reach verified completion: RESPONSE_FRAME_SIZE_LIMIT'});
  assert.equal(text,texts[2]);assert(events.some(e=>e.type==='text.replace'));
  const d=events.find(e=>e.type==='diagnostics');
  assert(d?.type==='diagnostics');assert.equal(d.diagnostics.transportError,'RESPONSE_FRAME_SIZE_LIMIT');
  assert.equal(d.diagnostics.model,'95a4c0abcba24364');
  assert.deepEqual(d.diagnostics.transport,transport);assert.equal(d.diagnostics.elapsedMs,150);assert.equal(d.diagnostics.httpStatus,200);
});

test('history preserves upstream RPC and Bard error codes',async()=>{
  const raw=JSON.stringify([['wrb.fr','hNvQHb',null,null,null,[5,null,[['BardErrorInfo',[1167]]]]]])+'\n';
  const backend=new NativeBackend({api:{history:async()=>raw} as any});
  await assert.rejects(backend.history('c_abcd'),{code:'UPSTREAM_HISTORY_REJECTED',message:'Upstream history RPC 5, BardErrorInfo 1167'});
});
