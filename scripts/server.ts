#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { databaseFile } from '../src/config.mjs';
import { NativeBackend } from '../src/api/native.ts';
import { ApiService } from '../src/api/service.ts';
import { createAgentMcpServer } from '../src/api/agent-mcp.ts';
import { startSessionKeepalive } from '../src/session-keepalive.mjs';

const backend = new NativeBackend();
const service = new ApiService({ database: databaseFile, backend });
const server = createAgentMcpServer(service, { localFiles: true });
const stopKeepalive = startSessionKeepalive(backend.api.auth, { notify: (state: string) => {
  console.error(JSON.stringify({ auth: state, ...(state === 'ready' ? {} : { next: 'Run npm run auth -- login in the installation directory; the server resumes without restarting. Use the saved account.' }) }));
} });
let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  await stopKeepalive();
  service.close();
  await server.close();
  process.exit(0);
};
server.server.onclose = () => { void stop(); };
process.stdin.once('end', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
await server.connect(new StdioServerTransport());
