import fs from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {AuthError} from './web-auth.mjs';

const exec = promisify(execFile);
const allowedMethods = new Set(['Target.getTargets', 'Target.attachToTarget', 'Network.getCookies', 'Target.detachFromTarget']);

export function localBrowserURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new AuthError('INVALID_BROWSER_ENDPOINT'); }
  if (url.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || !url.pathname.startsWith('/devtools/browser/')) {
    throw new AuthError('INVALID_BROWSER_ENDPOINT');
  }
  return url.href;
}

export async function discoverBrowser({env = process.env, platform = process.platform, home = homedir(), readFile = fs.readFile, execute = exec} = {}) {
  if (env.GEMINI_BROWSER_WS) return localBrowserURL(env.GEMINI_BROWSER_WS);
  let directories;
  if (env.GEMINI_CHROME_PROFILE) directories = [env.GEMINI_CHROME_PROFILE];
  else if (platform === 'win32') directories = env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data')] : [];
  else if (platform === 'darwin') directories = [join(home, 'Library', 'Application Support', 'Google', 'Chrome')];
  else {
    directories = [join(env.XDG_CONFIG_HOME || join(home, '.config'), 'google-chrome')];
    if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
      try {
        const {stdout} = await execute('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath("LocalApplicationData")'], {timeout: 5000});
        const windows = stdout.trim().match(/^([A-Za-z]):\\(.+)$/);
        if (windows) directories.push(`/mnt/${windows[1].toLowerCase()}/${windows[2].replaceAll('\\', '/')}/Google/Chrome/User Data`);
      } catch { /* Explicit profile path still works without Windows interop. */ }
    }
  }
  const endpoints = new Set();
  for (const directory of directories) {
    let content;
    try { content = await readFile(join(directory, 'DevToolsActivePort'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw new AuthError('BROWSER_PROFILE_UNREADABLE'); }
    const [port, path] = content.trim().split(/\r?\n/);
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(path || '')) throw new AuthError('INVALID_BROWSER_ENDPOINT');
    endpoints.add(localBrowserURL(`ws://127.0.0.1:${port}${path}`));
  }
  if (endpoints.size > 1) throw new AuthError('BROWSER_PROFILE_AMBIGUOUS');
  if (!endpoints.size) throw new AuthError('ENABLE_CHROME_REMOTE_DEBUGGING');
  return [...endpoints][0];
}

export async function connectBrowser(endpoint, {WebSocketImpl = WebSocket, timeoutMs = 120000} = {}) {
  const socket = new WebSocketImpl(localBrowserURL(endpoint));
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(new AuthError('BROWSER_COMMAND_FAILED'));
    else task.resolve(message.result);
  });
  const failPending = () => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new AuthError('BROWSER_DISCONNECTED')); }
    pending.clear();
  };
  socket.addEventListener('close', failPending);
  socket.addEventListener('error', failPending);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new AuthError('BROWSER_PERMISSION_TIMEOUT')); }, timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
    for (const event of ['error', 'close']) socket.addEventListener(event, () => { clearTimeout(timer); reject(new AuthError('BROWSER_UNAVAILABLE')); }, {once: true});
  });
  return {
    call(method, params = {}, sessionId) {
      if (!allowedMethods.has(method)) return Promise.reject(new AuthError('BROWSER_METHOD_FORBIDDEN'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new AuthError('BROWSER_COMMAND_TIMEOUT')); }, 15000);
        pending.set(id, {resolve, reject, timer});
        try { socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})})); }
        catch { clearTimeout(timer); pending.delete(id); reject(new AuthError('BROWSER_DISCONNECTED')); }
      });
    },
    close() { failPending(); socket.close(); },
  };
}

export async function readBrowserLogin(auth, call) {
  const {targetInfos} = await call('Target.getTargets');
  const pages = targetInfos.filter(target => {
    try { return target.type === 'page' && new URL(target.url).origin === 'https://gemini.google.com'; } catch { return false; }
  });
  if (!pages.length) throw new AuthError('OPEN_GEMINI_IN_BROWSER');
  if (new Set(pages.map(page => page.browserContextId || 'default')).size !== 1) throw new AuthError('BROWSER_PROFILE_AMBIGUOUS');
  const page = pages.find(page => !/^\/u\/[1-9]\d*(?:\/|$)/.test(new URL(page.url).pathname) && !/[?&]authuser=[1-9]/.test(page.url));
  if (!page) throw new AuthError('OPEN_DEFAULT_GEMINI_ACCOUNT');
  const {sessionId} = await call('Target.attachToTarget', {targetId: page.targetId, flatten: true});
  try {
    const {cookies} = await call('Network.getCookies', {urls: ['https://gemini.google.com/app']}, sessionId);
    const selected = cookies.filter(cookie => ['__Secure-1PSID', '__Secure-1PSIDTS'].includes(cookie.name));
    if (!selected.some(cookie => cookie.name === '__Secure-1PSID')) throw new AuthError('SIGN_IN_TO_GEMINI');
    return {...await auth.import(selected), source: 'browser'};
  } finally { await call('Target.detachFromTarget', {sessionId}).catch(() => {}); }
}

export async function browserLogin(auth, {discover = discoverBrowser, connect = connectBrowser, notify = () => {}, waitMs = 300000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))} = {}) {
  try { const session = await auth.ensure({detectProxy:true}); return {state: 'ready', account: session.account, source: 'saved_session'}; }
  catch (error) { if (error.code !== 'LOGIN_REQUIRED') throw error; }
  const endpoint = await discover();
  notify('ALLOW_CHROME_CONNECTION');
  // A single connection stays open while the user signs in: no repeated permission dialogs.
  const connection = await connect(endpoint);
  const deadline = Date.now() + waitMs;
  let previous;
  try {
    for (;;) {
      try { return await readBrowserLogin(auth, connection.call); }
      catch (error) {
        if (!['OPEN_GEMINI_IN_BROWSER', 'SIGN_IN_TO_GEMINI', 'MISSING_1PSID', 'LOGIN_REQUIRED'].includes(error.code) || Date.now() >= deadline) throw error;
        if (previous !== error.code) { notify(error.code); previous = error.code; }
        await sleep(2000);
      }
    }
  } finally { connection.close(); }
}
