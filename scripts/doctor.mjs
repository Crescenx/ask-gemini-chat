#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {installationConfig, projectDirectory, sessionFile} from '../src/config.mjs';
import {SessionAuth} from '../src/web-auth.mjs';

const report = {installed: false, transport: 'unchecked', authentication: 'unchecked', model: 'not_tested'};
let client, directory;
try {
  if (!installationConfig) throw Error('RUN_SETUP_FIRST');
  const config = installationConfig;
  const env = {...config.env, ...process.env};
  const python = spawnSync(env.GEMINI_HTTP_PYTHON, ['-c', 'from importlib.metadata import version; assert version("curl_cffi") == "0.16.3"'], {encoding: 'utf8', timeout: 10000});
  if (python.error || python.status !== 0) throw Error('PYTHON_DEPENDENCY_UNAVAILABLE');
  report.installed = true;
  directory = await mkdtemp(join(tmpdir(), 'gemini-doctor-'));
  client = new Client({name: 'ask-gemini-doctor', version: '1'});
  const transport = new StdioClientTransport({...config, env: {...env, WEBCHAT_DATABASE: join(directory, 'state.sqlite')}, cwd: tmpdir(), stderr: 'pipe'});
  await client.connect(transport);
  report.tools = (await client.listTools()).tools.map(tool => tool.name).sort();
  if (JSON.stringify(report.tools) !== JSON.stringify(['ask_gemini_chat', 'get_gemini_result', 'upload_gemini_file'])) throw Error('MCP_TOOLS_MISMATCH');
  report.transport = 'ready';
  const auth = await new SessionAuth({file: sessionFile}).status();
  report.authentication = auth.state;
  if(auth.network)report.network=auth.network;
  if(auth.proxy_error)report.proxy_error=auth.proxy_error;
  if (auth.code) report.authError = auth.code;
  report.ready = report.transport === 'ready' && report.authentication === 'ready';
  report.next = report.ready ? 'Run npm run verify for a real model check before starting the configured MCP client.'
    : auth.state==='login_required' ? 'Run npm run auth -- login; see INSTALL.md.'
    : 'Inspect network.attempts, proxy_error and authError. Repair the network/proxy and rerun doctor; preserve the saved login.';
  process.exitCode = report.ready ? 0 : 2;
} catch (error) {
  report.error = /^[A-Z_0-9]+$/.test(error.message) ? error.message : 'DOCTOR_FAILED';
  process.exitCode = 1;
} finally {
  await client?.close();
  if (directory) await rm(directory, {recursive: true, force: true});
  console.log(JSON.stringify(report));
  if (installationConfig) await writeFile(join(projectDirectory, '.runtime', 'doctor.json'), JSON.stringify(report, null, 2), {mode: 0o600});
}
