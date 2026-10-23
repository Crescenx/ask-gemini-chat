#!/usr/bin/env node
import { databaseFile } from '../src/config.mjs';
import { NativeBackend } from '../src/api/native.ts';
import { startSharedHost, sourceRevision } from '../src/api/shared-runtime.ts';
import { projectDirectory } from '../src/config.mjs';
import { runtimeConfiguration } from '../src/api/runtime-config.ts';
import { startSessionKeepalive } from '../src/session-keepalive.mjs';

try {
  const revision = sourceRevision(projectDirectory);
  const backend = new NativeBackend();
  let stop = async () => {};
  const host = await startSharedHost({ database: databaseFile, backend, revision,
    configuration: runtimeConfiguration(), currentRevision: () => sourceRevision(projectDirectory), stop: () => stop() });
  stop = startSessionKeepalive(backend.api.auth, { notify: (state: string) => console.error(JSON.stringify({ auth: state })) });
  process.once('SIGTERM', () => { void host.close(); });
  process.once('SIGINT', () => { void host.close(); });
} catch (error: any) { console.error(error.code ?? error.message); process.exitCode = error.code === 'DATABASE_LOCKED' ? 75 : 1; }
