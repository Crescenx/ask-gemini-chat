import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

export const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
// Local installer state is excluded from releases; credentials live separately.
let installation;
try { installation = JSON.parse(readFileSync(join(projectDirectory, '.runtime', 'install.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw Error('INVALID_INSTALLATION_STATE'); }
export const installedPython = installation?.python;
export const installationConfig = installation?.config;
const env = {...installationConfig?.env, ...process.env};
export const dataDirectory = resolve(env.GEMINI_DATA_DIR || join(homedir(), '.local', 'share', 'ask-gemini-chat'));
export const sessionFile = resolve(env.GEMINI_SESSION_FILE || join(dataDirectory, 'session.json'));
export const databaseFile = resolve(env.WEBCHAT_DATABASE || join(dataDirectory, 'state.sqlite'));
