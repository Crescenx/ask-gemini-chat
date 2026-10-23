#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { databaseFile } from '../src/config.mjs';
import { NativeBackend } from '../src/api/native.ts';
import { ApiService } from '../src/api/service.ts';
import { createAgentMcpServer } from '../src/api/agent-mcp.ts';

const service = new ApiService({ database: databaseFile, backend: new NativeBackend() });
const server = createAgentMcpServer(service, { localFiles: true });
let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  service.close();
  await server.close();
  process.exit(0);
};
server.server.onclose = () => { void stop(); };
process.stdin.once('end', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
await server.connect(new StdioServerTransport());
