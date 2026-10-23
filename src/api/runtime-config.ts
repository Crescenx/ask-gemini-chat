import { createHash } from 'node:crypto';
import { databaseFile, sessionFile, projectDirectory, installationConfig } from '../config.mjs';

export function runtimeConfiguration() {
  const env = { ...installationConfig?.env, ...process.env };
  return createHash('sha256').update(JSON.stringify({ databaseFile, sessionFile, projectDirectory,
    python: env.GEMINI_HTTP_PYTHON, proxy: env.HTTPS_PROXY ?? env.https_proxy })).digest('hex');
}
