import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('standalone stdio starts outside the checkout and exposes only three tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gemini-stdio-'));
  const client = new Client({ name: 'standalone-test', version: '1' });
  const env: NodeJS.ProcessEnv = { ...process.env, GEMINI_DATA_DIR: dir };
  delete env.WEBCHAT_DATABASE; delete env.GEMINI_SESSION_FILE;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../../scripts/server.ts', import.meta.url))],
    env: env as Record<string, string>, cwd: tmpdir(), stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(),
      ['ask_gemini_chat', 'get_gemini_result', 'upload_gemini_file']);
    assert((await stat(join(dir, 'state.sqlite'))).isFile());
    const result = await client.callTool({ name: 'get_gemini_result', arguments: { run_id: 'missing', wait_ms: 0 } });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse((result.content as any[])[0].text).error, 'RUN_NOT_FOUND');
    await client.close();
    await assert.rejects(stat(join(dir, 'state.sqlite.lock')), { code: 'ENOENT' });
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});
