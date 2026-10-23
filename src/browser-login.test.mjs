import test from 'node:test';
import assert from 'node:assert/strict';
import {AuthError} from './web-auth.mjs';
import {browserLogin, readBrowserLogin, discoverBrowser, connectBrowser, localBrowserURL} from './browser-login.mjs';

const missing = async () => { throw new AuthError('LOGIN_REQUIRED'); };
test('saved login and network errors never connect to the browser', async () => {
  const discover = async () => assert.fail('must not connect');
  assert.equal((await browserLogin({ensure: async () => ({account: 'same'})}, {discover})).source, 'saved_session');
  await assert.rejects(browserLogin({ensure: async () => { throw new AuthError('NETWORK_ERROR'); }}, {discover}), /NETWORK_ERROR/);
});

test('login reads only Gemini cookies, detaches on mismatch and never controls pages', async () => {
  for (const mismatch of [false, true]) {
    const methods = [];
    const call = async (method, params, sessionId) => {
      methods.push(method);
      if (method === 'Target.getTargets') return {targetInfos: [{type: 'page', url: 'https://gemini.google.com/app', targetId: 'page'}]};
      if (method === 'Target.attachToTarget') { assert.equal(params.targetId, 'page'); return {sessionId: 'read-only'}; }
      if (method === 'Network.getCookies') {
        assert.deepEqual(params.urls, ['https://gemini.google.com/app']); assert.equal(sessionId, 'read-only');
        return {cookies: [{name: '__Secure-1PSID', value: 'fake-cookie'}, {name: 'unrelated', value: 'excluded'}]};
      }
      assert.equal(method, 'Target.detachFromTarget'); return {};
    };
    const auth = {import: async cookies => {
      assert.deepEqual(cookies, [{name: '__Secure-1PSID', value: 'fake-cookie'}]);
      if (mismatch) throw new AuthError('ACCOUNT_MISMATCH');
      return {state: 'ready'};
    }};
    if (mismatch) await assert.rejects(readBrowserLogin(auth, call), /ACCOUNT_MISMATCH/);
    else assert.equal((await readBrowserLogin(auth, call)).state, 'ready');
    assert.deepEqual(methods, ['Target.getTargets', 'Target.attachToTarget', 'Network.getCookies', 'Target.detachFromTarget']);
  }
});

test('ambiguous or non-default Google accounts are not silently selected', async () => {
  for (const [pages, code] of [
    [[{type: 'page', url: 'https://gemini.google.com.evil.invalid/app'}], 'OPEN_GEMINI_IN_BROWSER'],
    [[{type: 'page', url: 'https://gemini.google.com/app', browserContextId: 'a'}, {type: 'page', url: 'https://gemini.google.com/app', browserContextId: 'b'}], 'BROWSER_PROFILE_AMBIGUOUS'],
    [[{type: 'page', url: 'https://gemini.google.com/u/1/app'}], 'OPEN_DEFAULT_GEMINI_ACCOUNT'],
    [[{type: 'page', url: 'https://gemini.google.com/app?authuser=2'}], 'OPEN_DEFAULT_GEMINI_ACCOUNT'],
  ]) await assert.rejects(readBrowserLogin({}, async () => ({targetInfos: pages})), new RegExp(code));
});

test('one connection is retained while waiting for sign-in, then closed', async () => {
  let connections = 0, reads = 0, closed = 0;
  const notices = [];
  const result = await browserLogin({ensure: missing, import: async () => ({state: 'ready'})}, {
    discover: async () => 'endpoint', notify: code => notices.push(code), sleep: async () => {},
    connect: async () => {
      connections++;
      return {close: () => closed++, call: async method => {
        if (method === 'Target.getTargets') return {targetInfos: ++reads === 1 ? [] : [{type: 'page', url: 'https://gemini.google.com/app', targetId: 'x'}]};
        if (method === 'Target.attachToTarget') return {sessionId: 's'};
        if (method === 'Network.getCookies') return {cookies: [{name: '__Secure-1PSID', value: 'fake-cookie'}]};
        return {};
      }};
    },
  });
  assert.equal(result.state, 'ready'); assert.equal(connections, 1); assert.equal(closed, 1);
  assert.deepEqual(notices, ['ALLOW_CHROME_CONNECTION', 'OPEN_GEMINI_IN_BROWSER']);
});

test('browser discovery supports native and WSL paths without guessing multiple profiles', async () => {
  const visited = [];
  const endpoint = await discoverBrowser({platform: 'linux', home: '/fake', env: {WSL_DISTRO_NAME: 'test'},
    execute: async (command, args) => { assert.equal(command, 'pwsh.exe'); assert(args.includes('-NonInteractive')); return {stdout: 'C:\\Users\\Example\\AppData\\Local\r\n'}; },
    readFile: async file => { visited.push(file); if (file.startsWith('/fake')) throw Object.assign(Error(), {code: 'ENOENT'}); return '9222\n/devtools/browser/abc-def\n'; },
  });
  assert.equal(endpoint, 'ws://127.0.0.1:9222/devtools/browser/abc-def');
  assert.equal(visited[1], '/mnt/c/Users/Example/AppData/Local/Google/Chrome/User Data/DevToolsActivePort');
  await assert.rejects(discoverBrowser({platform: 'linux', env: {}, readFile: async () => { throw Object.assign(Error(), {code: 'ENOENT'}); }}), /ENABLE_CHROME_REMOTE_DEBUGGING/);
  await assert.rejects(discoverBrowser({platform: 'linux', env: {GEMINI_CHROME_PROFILE: '/fake'}, readFile: async () => '0\n/devtools/browser/x'}), /INVALID_BROWSER_ENDPOINT/);
  for (const url of ['wss://example.com/devtools/browser/x', 'ws://127.0.0.1:22/not-browser', 'ws://user:pass@localhost/devtools/browser/x']) assert.throws(() => localBrowserURL(url), /INVALID_BROWSER_ENDPOINT/);
});

test('CDP transport correlates replies, redacts errors and prohibits page control', async () => {
  class Socket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(raw) {
      const {id, method} = JSON.parse(raw);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify(method === 'Network.getCookies' ? {id, error: {message: 'secret'}} : {id, result: {targetInfos: []}})})));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const connection = await connectBrowser('ws://localhost:9222/devtools/browser/test', {WebSocketImpl: Socket});
  try {
    assert.deepEqual(await connection.call('Target.getTargets'), {targetInfos: []});
    await assert.rejects(connection.call('Network.getCookies'), /^Error: BROWSER_COMMAND_FAILED$/);
    await assert.rejects(connection.call('Page.navigate'), /BROWSER_METHOD_FORBIDDEN/);
  } finally { connection.close(); }
});
