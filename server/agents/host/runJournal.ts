import { DatabaseSync } from 'node:sqlite';

export interface JournalRun {
  nonce: string;
  fingerprint: string;
  hostInstance: string;
  state: 'claimed' | 'running' | 'exited' | 'unknown';
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
}

/** A durable claim authorizes one launch. Stored PIDs never authorize adoption or termination. */
export class RunJournal {
  private db: DatabaseSync;
  constructor(
    file: string,
    private instance: string,
  ) {
    if (!instance.trim()) throw new Error('Missing host instance');
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS executions (
        nonce TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, host_instance TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('claimed','running','exited','unknown')),
        pid INTEGER, exit_code INTEGER, signal TEXT
      );`);
  }
  get(nonce: string): JournalRun | null {
    const row = this.db
      .prepare(
        `SELECT nonce,fingerprint,host_instance AS hostInstance,
      state,pid,exit_code AS exitCode,signal FROM executions WHERE nonce=?`,
      )
      .get(nonce) as unknown as JournalRun | undefined;
    if (!row) return null;
    if (row.hostInstance !== this.instance && ['claimed', 'running'].includes(row.state))
      return { ...row, state: 'unknown' };
    return row;
  }
  claim(nonce: string, fingerprint: string): { launch: boolean; run: JournalRun } {
    if (!nonce.trim() || !fingerprint.trim()) throw new Error('Missing launch identity');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db
        .prepare(
          `INSERT INTO executions(nonce,fingerprint,host_instance,state)
        VALUES(?,?,?,'claimed') ON CONFLICT(nonce) DO NOTHING`,
        )
        .run(nonce, fingerprint, this.instance);
      const run = this.get(nonce)!;
      if (run.fingerprint !== fingerprint)
        throw new Error('Launch nonce has conflicting arguments');
      this.db.exec('COMMIT');
      return { launch: result.changes === 1, run };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  started(nonce: string, pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid worker PID');
    return (
      this.db
        .prepare(
          `UPDATE executions SET state='running',pid=?
      WHERE nonce=? AND host_instance=? AND state='claimed'`,
        )
        .run(pid, nonce, this.instance).changes === 1
    );
  }
  finished(nonce: string, exitCode: number | null, signal: string | null): boolean {
    return (
      this.db
        .prepare(
          `UPDATE executions SET state='exited',exit_code=?,signal=?
      WHERE nonce=? AND host_instance=? AND state IN ('claimed','running')`,
        )
        .run(exitCode, signal, nonce, this.instance).changes === 1
    );
  }
  unknown(nonce: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE executions SET state='unknown'
      WHERE nonce=? AND host_instance=? AND state IN ('claimed','running')`,
        )
        .run(nonce, this.instance).changes === 1
    );
  }
  close(): void {
    this.db.close();
  }
}
