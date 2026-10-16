import type { Db } from '../../db.js';
import type { RunExecutionIdentity } from '../runExecution.js';
import { logicalSize } from '../logFile.js';
import { readRunRendezvous } from './runDaemon.js';
import { RunClient } from './runClient.js';
import { observeManagedRun } from './managedRun.js';

export function hasManagedExecution(db: Db, id: number, logPath: string): boolean {
  return !!db
    .prepare('SELECT 1 FROM agent_run_executions WHERE run_id=? AND run_log_path=? LIMIT 1')
    .get(id, logPath);
}

/** Reconcile owned execution only. Unknown ownership remains active and cannot free capacity. */
export async function recoverManagedRuns(
  db: Db,
  dataDir: string | null,
  active: () => boolean,
  changed: (id: number, logPath: string) => void,
) {
  const rows = db
    .prepare(
      `SELECT e.nonce,e.run_id AS runId,e.run_log_path AS runLogPath,e.attempt,
    e.fingerprint,e.host_instance AS hostInstance,e.host_generation AS hostGeneration,
    e.dispatch_key AS dispatchKey,e.orchestrator_id AS orchestratorId,e.created_at AS createdAt
    FROM agent_run_executions e JOIN agent_runs r ON r.id=e.run_id AND r.log_path=e.run_log_path
    WHERE r.status IN ('queued','running') AND e.attempt=(SELECT MAX(x.attempt) FROM agent_run_executions x WHERE x.run_id=e.run_id AND x.run_log_path=e.run_log_path)`,
    )
    .all() as unknown as RunExecutionIdentity[];
  if (!rows.length || !active()) return;
  let client: RunClient | undefined;
  try {
    if (!dataDir) throw new Error('Missing run host directory');
    const connection = readRunRendezvous(dataDir);
    client = await RunClient.connect(connection.address, connection.token, 3000);
    if (client.hostInstance !== connection.instance) throw new Error('Run host identity mismatch');
    for (const row of rows) {
      if (!active()) return;
      const observation = await observeManagedRun(client, row, logicalSize(row.runLogPath));
      if (!active()) return;
      const complete = observation.phase === 'complete';
      const state = observation.phase === 'unknown' ? 'unknown' : complete ? 'complete' : 'active';
      const status = complete ? observation.outcome! : 'running';
      const error =
        state === 'unknown'
          ? (observation.detail ?? 'Execution ownership is unknown')
          : complete && status === 'failed'
            ? `Hosted worker exited with code ${observation.exitCode ?? 'unknown'}`
            : null;
      db.prepare(
        `UPDATE agent_runs SET status=?,execution_state=?,attempts=MAX(attempts,?),error=?,exit_code=?,ended_at=?
        WHERE id=? AND log_path=? AND status IN ('queued','running')
        AND (status IS NOT ? OR execution_state IS NOT ? OR attempts < ? OR error IS NOT ?
          OR exit_code IS NOT ? OR (? = 0 AND ended_at IS NOT NULL))`,
      ).run(
        status,
        state,
        row.attempt,
        error,
        observation.exitCode ?? null,
        complete ? new Date().toISOString() : null,
        row.runId!,
        row.runLogPath,
        status,
        state,
        row.attempt,
        error,
        observation.exitCode ?? null,
        complete ? 1 : 0,
      );
      changed(row.runId!, row.runLogPath);
    }
  } catch {
    if (active())
      for (const row of rows) {
        db.prepare(
          `UPDATE agent_runs SET status='running',execution_state='unknown',error='Run host unavailable; execution ownership is unknown'
        WHERE id=? AND log_path=? AND status IN ('queued','running')
        AND (status IS NOT 'running' OR execution_state IS NOT 'unknown'
          OR error IS NOT 'Run host unavailable; execution ownership is unknown')`,
        ).run(row.runId!, row.runLogPath);
        changed(row.runId!, row.runLogPath);
      }
  } finally {
    client?.close();
  }
}

/** Only the authenticated owner can acknowledge stopping an execution. */
export async function stopManagedRun(db: Db, dataDir: string | null, id: number, logPath: string) {
  const identity = db
    .prepare(
      `SELECT nonce,host_instance AS hostInstance FROM agent_run_executions
    WHERE run_id=? AND run_log_path=? ORDER BY attempt DESC LIMIT 1`,
    )
    .get(id, logPath) as { nonce: string; hostInstance: string } | undefined;
  if (!identity) throw new Error('Execution identity is missing');
  let client: RunClient | undefined;
  try {
    if (!dataDir) throw new Error('Missing run host directory');
    const connection = readRunRendezvous(dataDir);
    client = await RunClient.connect(connection.address, connection.token, 5000);
    if (client.hostInstance !== connection.instance) throw new Error('Run host identity mismatch');
    const execution = await client.status(identity.nonce);
    if (
      !execution ||
      execution.nonce !== identity.nonce ||
      execution.hostInstance !== identity.hostInstance ||
      execution.state === 'unknown'
    )
      throw new Error('Execution ownership is unknown');
    if (!(await client.stop(identity.nonce))) throw new Error('Run host could not confirm stop');
    db.prepare(
      `UPDATE agent_runs SET status='killed',execution_state='complete',ended_at=?,error=NULL
      WHERE id=? AND log_path=? AND status IN ('queued','running')`,
    ).run(new Date().toISOString(), id, logPath);
  } catch (error) {
    db.prepare(
      `UPDATE agent_runs SET execution_state='unknown',error='Stop unconfirmed; execution may still be running'
      WHERE id=? AND log_path=? AND status IN ('queued','running')`,
    ).run(id, logPath);
    throw error;
  } finally {
    client?.close();
  }
}
