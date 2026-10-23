import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {clientConfig, codexConfig} from './setup.mjs';

test('generated config pins executable paths and forwards only runtime settings', () => {
  const config = clientConfig('/fake/python', {HTTPS_PROXY: 'http://localhost:1234', UNRELATED_SECRET: 'never-copy'}, '/fake/node', '/checkout with spaces');
  assert.deepEqual(config, {command: '/fake/node', args: ['/checkout with spaces/scripts/server.ts'], env: {GEMINI_HTTP_PYTHON: '/fake/python', HTTPS_PROXY: 'http://localhost:1234'}});
  const toml = codexConfig(config);
  assert(toml.includes('tool_timeout_sec = 180'));
  assert(toml.includes('args = ["/checkout with spaces/scripts/server.ts"]'));
  assert(!toml.includes('UNRELATED'));
  assert.throws(() => clientConfig('python'), /PYTHON_PATH_MUST_BE_ABSOLUTE/);
});

test('setup invoked outside npm exits with actionable JSON before any installation', () => {
  const env = {...process.env}; delete env.npm_execpath;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./setup.mjs', import.meta.url))], {env, encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr.trim()).code, 'RUN_NPM_RUN_SETUP');
});
