#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {mkdir, writeFile, access, readFile} from 'node:fs/promises';
import {resolve, join, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerExtension} from './prepare-extension.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export function clientConfig(python, env = process.env, node = process.execPath, directory = root) {
  if (!isAbsolute(python)) throw Error('PYTHON_PATH_MUST_BE_ABSOLUTE');
  const variables = {GEMINI_HTTP_PYTHON: python};
  for (const key of ['GEMINI_DATA_DIR', 'GEMINI_SESSION_FILE', 'WEBCHAT_DATABASE', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy']) {
    if (env[key]) variables[key] = env[key];
  }
  for (const key of ['GEMINI_DATA_DIR', 'GEMINI_SESSION_FILE', 'WEBCHAT_DATABASE']) if (variables[key]) variables[key] = resolve(variables[key]);
  return {command: node, args: [join(directory, 'scripts', 'server.ts')], env: variables};
}
export function codexConfig(config) {
  return '[mcp_servers.ask-gemini-chat]\ncommand = ' + JSON.stringify(config.command) +
    '\nargs = ' + JSON.stringify(config.args) + '\ntool_timeout_sec = 180\n\n[mcp_servers.ask-gemini-chat.env]\n' +
    Object.entries(config.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n') + '\n';
}
export function upgradeEnvironment(previous,env=process.env){
  const saved=previous?.config?.env??{};
  return {...saved,...(previous?.python?{GEMINI_HTTP_PYTHON:previous.python}:{}),...env};
}
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {cwd: root, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', timeout: 300000});
  if (result.error || result.status !== 0) throw Error('SETUP_COMMAND_FAILED');
  return result.stdout?.trim();
}
export async function setup() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('NODE_24_REQUIRED');
  // npm run setup supplies the current npm entrypoint, including on Windows.
  if (!process.env.npm_execpath) throw Error('RUN_NPM_RUN_SETUP');
  let previous;
  try{previous=JSON.parse(await readFile(join(root,'.runtime','install.json'),'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw Error('INVALID_INSTALLATION_STATE');}
  const env=upgradeEnvironment(previous);
  run(process.execPath, [process.env.npm_execpath, 'ci']);
  const managedPython=join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  let python = env.GEMINI_HTTP_PYTHON||managedPython;
  if (resolve(python)===resolve(managedPython)) {
    try { await access(python); }
    catch {
      const bootstrap = process.platform === 'win32' ? 'python' : 'python3';
      run(bootstrap, ['-c', 'import sys; assert sys.version_info >= (3, 10)']);
      run(bootstrap, ['-m', 'venv', join(root, '.venv')]);
    }
    run(python, ['-m', 'pip', 'install', '-r', join(root, 'requirements-http.txt')]);
  }
  // An explicit interpreter is checked, never silently modified.
  const checked = run(python, ['-c', 'import sys; from importlib.metadata import version; assert sys.version_info >= (3, 10); assert version("curl_cffi") == "0.16.3"; print(sys.executable)'], true);
  python = resolve(checked);
  const config = clientConfig(python,env);
  const directory = join(root, '.runtime');
  await mkdir(directory, {recursive: true, mode: 0o700});
  await writeFile(join(directory, 'install.json'), JSON.stringify({...previous,python, config}, null, 2) + '\n', {mode: 0o600});
  await writeFile(join(directory, 'mcp.json'), JSON.stringify({mcpServers: {'ask-gemini-chat': config}}, null, 2) + '\n', {mode: 0o600});
  await writeFile(join(directory, 'codex.toml'), codexConfig(config), {mode: 0o600});
  const extension=await registerExtension();
  console.log(JSON.stringify({state: 'installed', configFiles: ['.runtime/mcp.json', '.runtime/codex.toml'],extension,
    next:'Load extension/ in Chrome (reload once for older extensions). Existing login and MCP client settings are preserved. For first-time MCP registration and verification, see INSTALL.md.'}));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setup().catch(error => { console.error(JSON.stringify({state: 'error', code: error.message, next: 'Check Node 24+, Python 3.10+, npm and venv support. If GEMINI_HTTP_PYTHON is set, install requirements-http.txt into that explicit environment or unset it to create a local .venv.'})); process.exitCode = 1; });
}
