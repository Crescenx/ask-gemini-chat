import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { sharedClient } from '../../../src/api/shared-runtime.ts';

const call = sharedClient({ database: process.env.TEST_DATABASE!, root: process.cwd(), configuration: 'test',
  hostScript: fileURLToPath(new URL('./shared-host.ts', import.meta.url)) });
const server = new Server({ name: 'test', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, request => call('tools/list', request.params));
server.setRequestHandler(CallToolRequestSchema, request => call('tools/call', request.params));
process.stdin.once('end', () => { void server.close().then(() => process.exit()); });
await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: Infinity }));
