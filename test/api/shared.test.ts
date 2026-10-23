import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { alive } from '../../src/api/shared-runtime.ts';
import { Store } from '../../src/api/store.ts';
import { until } from './helpers.ts';

async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-shared-')), database = join(dir, 'state.sqlite');
  await writeFile(database + '.version', '1');
  const clients: Client[] = [];
  const host = async () => JSON.parse(await readFile(database + '.mcp.json', 'utf8'));
  const connect = async () => {
    const client = new Client({ name: 'multi-client-test', version: '1' }); clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/shared-stdio.ts', import.meta.url))],
      env: { ...process.env, TEST_DATABASE: database } as Record<string, string>, stderr: 'pipe' });
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 3);
    return client;
  };
  t.after(async () => {
    await writeFile(database + '.release', '');
    await Promise.all(clients.map(c => c.close()));
    await until(() => !existsSync(database + '.lock'));
    await rm(dir, { recursive: true, force: true });
  });
  return { database, host, connect, calls: async () => (await readFile(database + '.calls', 'utf8')).trim().split('\n') };
}
async function call(client: Client, name: string, args: any) {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse((result.content as any[])[0].text);
}

test('startup waits through the previous database owner exiting', async t => {
  const x = await fixture(t);
  const previous = new Store(x.database);
  const connecting = x.connect();
  await delay(500); previous.close();
  const client = await connecting;
  assert.equal((await client.listTools()).tools.length, 3);
});

test('concurrent stdio clients share one owner, deduplicate requests, and survive a hot reload in place', async t => {
  const x = await fixture(t);
  const [a, b] = await Promise.all([x.connect(), x.connect()]);
  const old = await x.host();
  const unauthorized = await fetch(`http://127.0.0.1:${old.port}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401);
  const input = { request_id: 'shared', prompt: 'hello', wait_ms: 0 };
  const [one, two] = await Promise.all([call(a, 'ask_gemini_chat', input), call(b, 'ask_gemini_chat', input)]);
  assert.equal(one.run_id, two.run_id);
  assert.equal((await x.calls()).length, 1);
  assert.equal((await call(b, 'get_gemini_result', { run_id: one.run_id, wait_ms: 1000 })).text, 'reply:hello');

  const blocked = await call(a, 'ask_gemini_chat', { request_id: 'blocked', prompt: 'block until released', wait_ms: 0 });
  await writeFile(x.database + '.version', '2');
  await delay(700);
  assert.equal((await x.host()).pid, old.pid);
  assert.equal((await call(b, 'get_gemini_result', { run_id: blocked.run_id, wait_ms: 0 })).status, 'running');
  // An update must not block new work behind a long-running generation.
  const during = await call(b, 'ask_gemini_chat', { request_id: 'during-reload', prompt: 'still available', wait_ms: 1000 });
  assert.equal(during.text, 'reply:still available');
  assert.equal((await x.host()).pid, old.pid);
  await writeFile(x.database + '.release', '');
  await until(() => !alive(old.pid));
  const result = await call(b, 'ask_gemini_chat', { request_id: 'after-reload', prompt: 'new code', wait_ms: 1000 });
  assert.equal(result.text, 'reply:new code');
  assert.notEqual((await x.host()).pid, old.pid);
  assert.equal((await x.host()).revision, '2');
  assert.equal((await call(a, 'get_gemini_result', { run_id: blocked.run_id, wait_ms: 0 })).text, 'reply:block until released');
  assert.equal((await call(a, 'ask_gemini_chat', input)).run_id, one.run_id);
  assert.equal((await x.calls()).length, 4);
  assert.equal(alive(old.pid), false);
});

test('disconnect does not cancel a shared generation; a crashed host preserves uncertain request identity', async t => {
  const x = await fixture(t);
  const a = await x.connect();
  const args = { request_id: 'keep-running', prompt: 'block detached generation', mode: 'temporary', wait_ms: 0 };
  const run = await call(a, 'ask_gemini_chat', args);
  const owner = await x.host();
  await a.close(); await delay(700);
  assert.equal(alive(owner.pid), true);
  const b = await x.connect();
  assert.equal((await call(b, 'get_gemini_result', { run_id: run.run_id, wait_ms: 0 })).status, 'running');
  process.kill(owner.pid, 'SIGKILL');
  await until(() => !alive(owner.pid));
  const recovered = await call(b, 'get_gemini_result', { run_id: run.run_id, wait_ms: 0 });
  assert.equal(recovered.status, 'uncertain');
  assert.equal(recovered.error.code, 'TEMPORARY_RESULT_UNRECOVERABLE');
  assert.equal((await call(b, 'ask_gemini_chat', args)).run_id, run.run_id);
  assert.equal((await x.calls()).length, 1);
});
