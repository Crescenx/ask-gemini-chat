import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunEvent } from './types.ts';
import { ApiError } from './types.ts';

export class Store {
  db: DatabaseSync;
  owner: DatabaseSync;
  lock: string;
  closed = false;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.owner = new DatabaseSync(path + '.owner.sqlite');
    chmodSync(path + '.owner.sqlite', 0o600);
    try { this.owner.exec('BEGIN IMMEDIATE'); }
    catch { this.owner.close(); throw new ApiError('DATABASE_LOCKED'); }
    this.lock = path + '.lock';
    // Serialize stale PID-lock takeover while remaining compatible with old servers.
    try {
      try { const fd = openSync(this.lock, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); }
      catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number(readFileSync(this.lock, 'utf8'));
        if (!Number.isInteger(pid) || pid <= 0) throw new ApiError('DATABASE_LOCKED');
        try { process.kill(pid, 0); throw new ApiError('DATABASE_LOCKED'); }
        catch (e: any) { if (e.code !== 'ESRCH') throw e; }
        unlinkSync(this.lock);
        const fd = openSync(this.lock, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
      }
      try {
        this.db = new DatabaseSync(path);
        chmodSync(path, 0o600);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
          CREATE TABLE IF NOT EXISTS records (ns TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(ns,id));
          CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, data TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS run_events ON events(run_id,id);`);
      } catch (error) { unlinkSync(this.lock); throw error; }
    } catch (error) { this.owner.close(); throw error; }
  }
  get<T = any>(ns: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM records WHERE ns=? AND id=?').get(ns, id);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  put(ns: string, id: string, value: unknown) {
    this.db.prepare('INSERT INTO records(ns,id,data) VALUES(?,?,?) ON CONFLICT(ns,id) DO UPDATE SET data=excluded.data').run(ns, id, JSON.stringify(value));
  }
  list<T = any>(ns: string): T[] { return this.db.prepare('SELECT data FROM records WHERE ns=? ORDER BY rowid').all(ns).map(r => JSON.parse(String(r.data))); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(runId: string, type: string, data: Record<string, unknown> = {}): RunEvent {
    const value = { ...data, runId, type, at: new Date().toISOString() };
    const result = this.db.prepare('INSERT INTO events(run_id,data) VALUES(?,?)').run(runId, JSON.stringify(value));
    return { ...value, id: Number(result.lastInsertRowid) };
  }
  events(runId: string, after: number): RunEvent[] {
    return this.db.prepare('SELECT id,data FROM events WHERE run_id=? AND id>? ORDER BY id LIMIT 1000').all(runId, after).map(r => ({ ...JSON.parse(String(r.data)), id: Number(r.id) }));
  }
  close() { if (this.closed) return; this.closed = true; this.db.close(); unlinkSync(this.lock); this.owner.close(); }
}
