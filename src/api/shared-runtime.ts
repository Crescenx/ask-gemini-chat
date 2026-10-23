import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createAgentMcpServer } from './agent-mcp.ts';
import { ApiService } from './service.ts';
import type { Backend } from './types.ts';

export function sourceRevision(root: string): string {
  const hash = createHash('sha256');
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(?:ts|mjs|py)$/.test(entry.name) && !entry.name.includes('.test.')) hash.update(file).update(readFileSync(file));
    }
  }
  visit(join(root, 'src')); visit(join(root, 'scripts'));
  hash.update(readFileSync(join(root, 'package.json')));
  try { hash.update(readFileSync(join(root, 'package-lock.json'))); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  return hash.digest('hex');
}

export function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error: any) { return error.code !== 'ESRCH'; }
}
type Host = { pid: number; port: number; token: string; revision: string; configuration: string };
const hostFile = (database: string) => database + '.mcp.json';
function readHost(database: string): Host | undefined {
  try {
    const host = JSON.parse(readFileSync(hostFile(database), 'utf8'));
    if (alive(host.pid) && Number.isInteger(host.port) && host.port > 0 && host.port <= 65535 && /^[a-f0-9]{64}$/.test(host.token)) return host;
  } catch (error: any) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
}

export async function startSharedHost(options: {
  database: string; backend: Backend; revision: string; configuration: string;
  currentRevision: () => string; stop?: () => Promise<void>;
}) {
  const service = new ApiService(options);
  const token = randomBytes(32).toString('hex');
  const clients = new Set<number>();
  let active = 0, draining = false, stopping = false, connected = false;
  const started = Date.now();
  const busy = () => active > 0 || service.active;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(404).end(); return; }
    const pid = Number(req.headers['x-mcp-client']);
    if (!alive(pid)) { res.writeHead(400).end(); return; }
    clients.add(pid);
    connected = true;
    // Rejected before dispatch: the proxy may safely wait and retry this request.
    if (stopping) { res.writeHead(503, { 'x-mcp-reloading': 'true' }).end(); return; }
    active++;
    const mcp = createAgentMcpServer(service, { localFiles: true });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let finished = false;
    const finish = () => { if (finished) return; finished = true; active--; void mcp.close(); };
    res.once('close', finish);
    try {
      // Parse without the SDK HTTP default's 4 MiB cap, as with stdio input.
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (draining && body.method === 'tools/call' && body.params?.name !== 'get_gemini_result') {
        res.writeHead(503, { 'x-mcp-reloading': 'true' }).end(); return;
      }
      await mcp.connect(transport); await transport.handleRequest(req, res, body);
    }
    catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  // Node's incoming request timer must not impose an upload/input size limit by duration.
  server.requestTimeout = 0;
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('HOST_ADDRESS_UNAVAILABLE');
  const host: Host = { pid: process.pid, port: address.port, token, revision: options.revision, configuration: options.configuration };
  const temp = hostFile(options.database) + '.' + process.pid;
  writeFileSync(temp, JSON.stringify(host), { mode: 0o600 }); renameSync(temp, hostFile(options.database));
  const close = async () => {
    if (stopping) return;
    stopping = true; clearInterval(timer);
    await new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); });
    await options.stop?.();
    service.close();
    try { if (JSON.parse(readFileSync(hostFile(options.database), 'utf8')).token === token) unlinkSync(hostFile(options.database)); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  };
  const timer = setInterval(() => {
    try {
      const changed = options.currentRevision() !== options.revision;
      // Existing calls and detached generations finish on their original code.
      if (changed && !busy()) draining = true;
      for (const pid of clients) if (!alive(pid)) clients.delete(pid);
      if ((draining || (clients.size === 0 && (connected || Date.now() - started > 5000))) && !busy()) void close();
    } catch { /* An incomplete file save is retried on the next check. */ }
  }, 500);
  return { service, host, close };
}

export function sharedClient(options: { database: string; root: string; configuration: string; hostScript?: string }) {
  let starting: Promise<Host> | undefined;
  async function ensureHost(): Promise<Host> {
    const existing = readHost(options.database);
    if (existing) {
      if (existing.configuration !== options.configuration) throw Error('MCP_HOST_CONFIG_MISMATCH');
      return existing;
    }
    if (starting) return starting;
    starting = (async () => {
      mkdirSync(dirname(options.database), { recursive: true, mode: 0o700 });
      let failure: Error | undefined;
      let exited: number | null | undefined;
      const launch = () => {
        exited = undefined;
        const log = openSync(options.database + '.mcp.log', 'a', 0o600);
        const child = spawn(process.execPath, [options.hostScript ?? join(options.root, 'scripts', 'host.ts')], {
          env: process.env, cwd: options.root, detached: true, stdio: ['ignore', log, log],
        });
        closeSync(log); child.unref();
        child.once('error', error => { failure = error; });
        child.once('exit', code => { exited = code; });
      };
      launch();
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const host = readHost(options.database);
        if (host) {
          if (host.configuration !== options.configuration) throw Error('MCP_HOST_CONFIG_MISMATCH');
          return host;
        }
        if (failure) throw failure;
        if (exited !== undefined) {
          if (exited !== 75) throw Error('MCP_HOST_START_FAILED');
          await delay(250);
          if (!readHost(options.database)) launch();
        }
        await delay(50);
      }
      throw Error('MCP_HOST_START_FAILED');
    })();
    try { return await starting; } finally { starting = undefined; }
  }
  return async (method: string, params: unknown = {}) => {
    for (;;) {
      const host = await ensureHost();
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
      const response = await new Promise<{ status: number; reloading: boolean; body: string }>((accept, reject) => {
        let connected = false;
        const req = request({ hostname: '127.0.0.1', port: host.port, path: '/mcp', method: 'POST', headers: {
          authorization: `Bearer ${host.token}`, 'x-mcp-client': String(process.pid),
          'content-type': 'application/json', accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body), 'mcp-protocol-version': '2025-03-26',
        } }, res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () => accept({ status: res.statusCode!, reloading: res.headers['x-mcp-reloading'] === 'true', body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('socket', socket => { if (!socket.connecting) connected = true; else socket.once('connect', () => { connected = true; }); });
        req.on('error', (error: NodeJS.ErrnoException) => {
          if (!connected && error.code === 'ECONNREFUSED') accept({ status: 503, reloading: true, body: '' });
          else reject(error);
        });
        req.end(body);
      });
      if (response.status === 503 && response.reloading) { await delay(100); continue; }
      if (response.status !== 200) throw Error(`MCP_HOST_HTTP_${response.status}`);
      const rpc = JSON.parse(response.body);
      if (rpc.error) throw Error(rpc.error.message);
      return rpc.result;
    }
  };
}
