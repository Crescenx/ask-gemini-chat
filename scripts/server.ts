#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { databaseFile, projectDirectory } from '../src/config.mjs';
import { sharedClient, sourceRevision } from '../src/api/shared-runtime.ts';
import { runtimeConfiguration } from '../src/api/runtime-config.ts';

const call = sharedClient({ database: databaseFile, root: projectDirectory, configuration: runtimeConfiguration() });
const server = new Server({ name: 'ask-gemini-chat', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } });
server.setRequestHandler(ListToolsRequestSchema, request => call('tools/list', request.params));
server.setRequestHandler(CallToolRequestSchema, request => call('tools/call', request.params));
let revision = sourceRevision(projectDirectory);
const timer = setInterval(() => {
  try {
    const next = sourceRevision(projectDirectory);
    if (revision !== next) { revision = next; void server.notification({ method: 'notifications/tools/list_changed' }).catch(() => {}); }
  } catch { /* Retry after the source update finishes. */ }
}, 1000);
timer.unref();
const stop = async () => { clearInterval(timer); await server.close(); process.exit(0); };
process.stdin.once('end', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: Infinity }));
