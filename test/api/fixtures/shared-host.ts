import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { startSharedHost } from '../../../src/api/shared-runtime.ts';
import { Remote } from '../helpers.ts';
import type { Generation, Observation } from '../../../src/api/types.ts';

class RecordedRemote extends Remote {
  async generate(input: Generation, observe: (event: Observation) => void) {
    appendFileSync(process.env.TEST_DATABASE + '.calls', input.id + '\n');
    while (input.input.text.startsWith('block') && !existsSync(process.env.TEST_DATABASE + '.release')) await delay(10);
    return super.generate(input, observe);
  }
}
const currentRevision = () => readFileSync(process.env.TEST_DATABASE + '.version', 'utf8');
const backend = new RecordedRemote(); backend.sequence = process.pid;
try {
  const host = await startSharedHost({ database: process.env.TEST_DATABASE!, backend,
    revision: currentRevision(), currentRevision, configuration: 'test' });
  process.once('SIGTERM', () => { void host.close(); });
} catch (error: any) { console.error(error.code ?? error.message); process.exitCode = error.code === 'DATABASE_LOCKED' ? 75 : 1; }
