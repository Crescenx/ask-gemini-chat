import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentMcpServer } from '../../src/api/agent-mcp.ts';
import { MAX_FILE_BYTES } from '../../src/upload-limits.mjs';
import { ApiService } from '../../src/api/service.ts';
import { Remote, until } from './helpers.ts';

async function setup(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-mcp-'));
  const backend = new Remote();
  const service = new ApiService({ database: join(dir, 'state.sqlite'), backend });
  const server = createAgentMcpServer(service);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'agent-test', version: '1' });
  await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); service.close(); await rm(dir, { recursive: true, force: true }); });
  const call = async (name: string, args: any) => {
    const response = await client.callTool({ name, arguments: args });
    const content = response.content as any[];
    assert.equal(content.length, 1); assert.equal(content[0].type, 'text');
    return { ...JSON.parse(content[0].text), isError: response.isError };
  };
  return { backend, service, client, call };
}
test('agent MCP: discover, ask, continue and replay without a second generation', async t => {
  const { backend, client, call } = await setup(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['ask_gemini_chat', 'get_gemini_result']);
  const args = { request_id: 'one', prompt: 'hello', wait_ms: 1000 };
  const first = await call('ask_gemini_chat', args);
  assert.equal(first.status, 'completed'); assert.equal(first.text, 'reply:hello');
  assert.equal((await call('ask_gemini_chat', args)).run_id, first.run_id);
  assert.equal(backend.generations.length, 1);
  assert.equal((await call('ask_gemini_chat', { ...args, prompt: 'changed' })).error, 'IDEMPOTENCY_CONFLICT');
  const second = await call('ask_gemini_chat', { request_id: 'two', prompt: 'continue', chat_id: first.chat_id, wait_ms: 1000 });
  assert.equal(second.text, 'reply:continue'); assert.equal(second.chat_id, first.chat_id);
  assert.deepEqual(backend.generations[1].parent, first.position);
  assert.equal((await call('get_gemini_result', { run_id: first.run_id, wait_ms: 0 })).text, first.text);
  const invalid = await client.callTool({ name: 'ask_gemini_chat', arguments: { ...args, connector: { id: 'anything' } } });
  assert.equal(invalid.isError, true); assert.equal(backend.generations.length, 2);
});
test('slow and uncertain answers keep their original run and recover only by history', async t => {
  const { backend, service, call } = await setup(t);
  let release!: () => void;
  backend.gate = new Promise<void>(resolve => { release = resolve; });
  backend.failAfterWrite = true;
  const args = { request_id: 'slow', prompt: 'slow hello', wait_ms: 0 };
  const first = await call('ask_gemini_chat', args);
  assert.equal(first.status, 'running');
  assert.equal((await call('ask_gemini_chat', args)).run_id, first.run_id);
  assert.equal((await call('get_gemini_result', { run_id: first.run_id, wait_ms: 0 })).status, 'running');
  release(); await until(() => service.getRun(first.run_id).status === 'uncertain');
  const recovered = await call('get_gemini_result', { run_id: first.run_id, wait_ms: 0 });
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.text, 'reply:slow hello');
  assert.equal(backend.generations.length, 1);
});
test('local MCP uploads file bytes once, attaches by ID, and rejects changed or invalid files', async t => {
  const { backend, service } = await setup(t);
  const dir = await mkdtemp(join(tmpdir(), 'agent-file-'));
  const server = createAgentMcpServer(service, { localFiles: true });
  const client = new Client({ name: 'local-agent', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['ask_gemini_chat', 'get_gemini_result', 'upload_gemini_file']);
  const call = async (name: string, args: any) => {
    const r = await client.callTool({ name, arguments: args });
    return JSON.parse((r.content as any[])[0].text);
  };
  const path = join(dir, 'receipt.txt'), content = '仅在附件里出现的回执 🌲';
  await writeFile(path, content);
  let uploads = 0;
  backend.upload = async (bytes, name) => {
    uploads++; assert.equal(Buffer.from(bytes).toString(), content);
    return { name, reference: 'uploaded-receipt', size: bytes.length };
  };
  const args = { request_id: 'upload-1', path };
  const file = await call('upload_gemini_file', args);
  assert.equal(file.size, Buffer.byteLength(content));
  assert.equal((await call('upload_gemini_file', args)).file_id, file.file_id);
  assert.equal(uploads, 1);
  const answer = await call('ask_gemini_chat', { request_id: 'file-question', prompt: 'Read the receipt', file_ids: [file.file_id], wait_ms: 1000 });
  assert.equal(answer.status, 'completed');
  assert.equal(backend.generations[0].input.files[0].reference, 'uploaded-receipt');
  await writeFile(path, 'changed');
  assert.equal((await call('upload_gemini_file', args)).error, 'IDEMPOTENCY_CONFLICT');
  await truncate(path, MAX_FILE_BYTES + 1);
  assert.equal((await call('upload_gemini_file', { ...args, request_id: 'too-large' })).error, 'FILE_TOO_LARGE');
  assert.equal((await call('upload_gemini_file', { request_id: 'directory', path: dir })).error, 'INVALID_FILE');
  const relative = await client.callTool({ name: 'upload_gemini_file', arguments: { request_id: 'relative', path: 'receipt.txt' } });
  assert.equal(relative.isError, true);
  assert.equal(uploads, 1);
});
