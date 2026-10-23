#!/usr/bin/env node
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {installationConfig, dataDirectory} from '../src/config.mjs';
import {WebAPI, GENERATION_WAIT_MS} from '../src/web-client.mjs';
import {historyTurns, ARGON} from '../src/web-protocol.mjs';

let client, record;
const file = join(dataDirectory, 'install-check.json');
const save = () => writeFile(file, JSON.stringify(record, null, 2), {mode: 0o600});
try {
  if (!installationConfig) throw Error('RUN_SETUP_FIRST');
  await mkdir(dataDirectory, {recursive: true, mode: 0o700});
  try { record = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const id = randomUUID(), receipt = `READY-${id}`;
    record = {request_id: `install-check-${id}`, receipt, prompt: `Reply with exactly this text and nothing else: ${receipt}`};
    // Persist identity before sending; a second invocation reuses the original request.
    await writeFile(file, JSON.stringify(record), {flag: 'wx', mode: 0o600});
  }
  if (record.passed) {
    console.log(JSON.stringify({passed: true, cached: true, checkedAt: record.checkedAt, actualModel: record.actualModel, next: 'Prior verification reused; this is not a new availability check.'}));
  } else {
    client = new Client({name: 'ask-gemini-install-check', version: '1'});
    await client.connect(new StdioClientTransport({...installationConfig, env: {...installationConfig.env, ...process.env}, stderr: 'pipe'}));
    const call = async (name, args) => {
      const result = await client.callTool({name, arguments: args}, undefined, {timeout: 180000});
      const value = JSON.parse(result.content[0].text);
      if (result.isError) throw Error(value.error?.code || value.error || 'MCP_ERROR');
      return value;
    };
    let result = record.run_id ? await call('get_gemini_result', {run_id: record.run_id, wait_ms: 0}) :
      await call('ask_gemini_chat', {request_id: record.request_id, prompt: record.prompt, mode: 'normal', wait_ms: 0});
    record.run_id = result.run_id; await save();
    const deadline = Date.now() + GENERATION_WAIT_MS;
    while (['running', 'uncertain'].includes(result.status) && Date.now() < deadline) {
      if (result.status === 'uncertain') await new Promise(resolve => setTimeout(resolve, 2000));
      result = await call('get_gemini_result', {run_id: record.run_id, wait_ms: 20000});
      console.error(JSON.stringify({state: result.status, run_id: record.run_id}));
    }
    if (result.status !== 'completed') throw Error('MODEL_CHECK_UNRESOLVED');
    if (result.text.trim() !== record.receipt) throw Error('MODEL_ANSWER_MISMATCH');
    const turns = historyTurns(await new WebAPI().history(result.position.cid));
    const turn = turns.find(turn => turn.metadata[1] === result.position.rid && turn.metadata[2] === result.position.rcid);
    if (turn?.model !== ARGON) throw Error('MODEL_ID_MISMATCH');
    record.actualModel = turn.model; record.passed = true; record.checkedAt = new Date().toISOString(); await save();
    console.log(JSON.stringify({passed: true, actualModel: record.actualModel, checkedAt: record.checkedAt}));
  }
} catch (error) {
  console.error(JSON.stringify({passed: false, code: /^[A-Z_0-9]+$/.test(error.message) ? error.message : 'MODEL_CHECK_FAILED', run_id: record?.run_id,
    next: 'Fix the reported problem and rerun this command. It retains the original request ID. Do not delete install-check.json to retry an uncertain request.'}));
  process.exitCode = 1;
} finally { await client?.close(); }
