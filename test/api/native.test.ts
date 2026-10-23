import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeBackend } from '../../src/api/native.ts';
import type { Generation, Observation } from '../../src/api/types.ts';

const candidate = (rcid: string, text: string, status = 2) => [rcid, [text], null, null, null, null, null, null, [status]];
const history = (rows: any[]) => JSON.stringify([['wrb.fr', 'hNvQHb', JSON.stringify([rows])]]) + '\n';
const row = (rid: string, text: string, answer: string, status = 2) => [['c_abcd', rid], null, [[text, 0, null, null]], [[candidate('rc_' + rid.slice(2), answer, status)], null, null, 'rc_' + rid.slice(2)]];
const generation = (rid: string, text: string) => JSON.stringify([['wrb.fr', null, JSON.stringify([null, ['c_abcd', rid], null, null, [candidate('rc_' + rid.slice(2), text)]])]]) + '\n';
const request: Generation = { id: 'req-1', accountId: 'default', model: 'argon', operation: 'fork-in-place', cid: 'c_abcd', at: { cid: 'c_abcd', rid: 'r_2', rcid: 'rc_2' }, parent: { cid: 'c_abcd', rid: 'r_1', rcid: 'rc_1' }, input: { text: 'replacement', files: [{ name: 'image.png', reference: [['/contrib_service/test'], 'image.png'] }] }, baseline: [{ cid: 'c_abcd', rid: 'r_1', rcid: 'rc_1' }, { cid: 'c_abcd', rid: 'r_2', rcid: 'rc_2' }] };

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

test('a generation still running after ten minutes is awaited without resubmission', async t => {
  let now = 0, polls = 0, submissions = 0;
  t.mock.method(Date, 'now', () => now);
  const api = {
    start: async () => { submissions++; return request.id; },
    poll: async () => {
      if (++polls === 1) { now = 10 * 60 * 1000; return { done: false, raw: '' }; }
      return { done: true, exhausted: true, status: 200, raw: generation('r_3', 'answer') };
    },
    history: async () => history([row('r_3', 'replacement', 'answer'), row('r_1', 'first', 'first answer')]),
  };
  const result = await new NativeBackend({ api: api as any, pollMs: 1 }).generate(request, () => {});
  assert.equal(result.position.rid, 'r_3'); assert.equal(submissions, 1); assert.equal(polls, 2);
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
