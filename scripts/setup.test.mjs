import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {clientConfig, codexConfig,upgradeEnvironment} from './setup.mjs';
import {update} from './update.mjs';

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

test('upgrade keeps custom data, interpreter and proxy unless explicitly overridden',()=>{
  const previous={python:'/custom/python',config:{env:{GEMINI_DATA_DIR:'/private/data',GEMINI_SESSION_FILE:'/private/login.json',WEBCHAT_DATABASE:'/private/chat.sqlite',HTTPS_PROXY:'http://old-proxy'}}};
  const env=upgradeEnvironment(previous,{});
  assert.equal(env.GEMINI_HTTP_PYTHON,'/custom/python');
  assert.equal(env.GEMINI_SESSION_FILE,'/private/login.json');
  assert.equal(env.WEBCHAT_DATABASE,'/private/chat.sqlite');
  assert.equal(env.HTTPS_PROXY,'http://old-proxy');
  assert.equal(upgradeEnvironment(previous,{HTTPS_PROXY:'http://new-proxy'}).HTTPS_PROXY,'http://new-proxy');
  assert.equal(clientConfig(env.GEMINI_HTTP_PYTHON,env).env.GEMINI_DATA_DIR,'/private/data');
});

test('update fast-forwards then sets up; failed pulls never reset or continue',()=>{
  const calls=[];
  update({npm:'/npm.js',run:(...args)=>calls.push(args)});
  assert.deepEqual(calls,[['git',['pull','--ff-only']],[process.execPath,['/npm.js','run','setup']]]);
  let count=0;
  assert.throws(()=>update({npm:'/npm.js',run:()=>{count++;throw Error('conflict');}}),/conflict/);
  assert.equal(count,1);
  assert.throws(()=>update({npm:'',run:()=>assert.fail()}),/RUN_NPM_RUN_UPDATE/);
});
