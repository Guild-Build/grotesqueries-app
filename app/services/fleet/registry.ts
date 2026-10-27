import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPublicKey } from 'node:crypto';
import { assertManagedPath } from '../../helpers/runtime.js';
import { ACTIONS, identity, type Admission } from './contracts.js';

/** Coordinator-local metadata only: no credentials, terminal history or shared-network database. */
export class FleetRegistry {
  private readonly db: DatabaseSync;
  readonly admissions = new Map<string, Admission>();
  constructor(root: string, file: string, workers: readonly Admission[], developmentAccept: boolean) {
    if (workers.length > 32) throw new Error('At most 32 admitted workers.');
    for (const worker of workers) {
      if (!identity(worker.id) || this.admissions.has(worker.id) || !worker.label.trim() || Buffer.byteLength(worker.label) > 256 ||
        worker.actions?.some(action => !ACTIONS.includes(action))) throw new Error('Invalid worker admission.');
      if (!developmentAccept && (!worker.publicKey || createPublicKey(worker.publicKey).asymmetricKeyType !== 'ed25519')) throw new Error('An admitted Ed25519 public key is required.');
      this.admissions.set(worker.id, { ...worker, actions: [...(worker.actions ?? ACTIONS)] });
    }
    const target = assertManagedPath(root, path.resolve(file)); fs.mkdirSync(path.dirname(target), { recursive: true });
    this.db = new DatabaseSync(target);
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, label TEXT NOT NULL, public_key TEXT, admitted INTEGER NOT NULL, instance_id TEXT, last_seen TEXT)');
      this.db.exec('BEGIN IMMEDIATE');
      this.db.exec('UPDATE workers SET admitted=0');
      const put = this.db.prepare('INSERT INTO workers(id,label,public_key,admitted) VALUES(?,?,?,1) ON CONFLICT(id) DO UPDATE SET label=excluded.label,public_key=excluded.public_key,admitted=1');
      for (const worker of this.admissions.values()) put.run(worker.id, worker.label, worker.publicKey ?? null);
      this.db.exec('COMMIT');
    } catch (error) { this.db.close(); throw error; } // Closing rolls back any active transaction, including failed setup.
  }
  seen(id: string, instanceId: string): void { this.db.prepare('UPDATE workers SET instance_id=?,last_seen=? WHERE id=? AND admitted=1').run(instanceId, new Date().toISOString(), id); }
  list(): Array<{ id: string; label: string; instanceId: string | null; lastSeen: string | null }> {
    return this.db.prepare('SELECT id,label,instance_id AS instanceId,last_seen AS lastSeen FROM workers WHERE admitted=1 ORDER BY id').all() as ReturnType<FleetRegistry['list']>;
  }
  close(): void { this.db.close(); }
}
