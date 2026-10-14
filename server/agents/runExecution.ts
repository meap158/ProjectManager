import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db.js';

export interface RunExecutionIdentity {
  nonce: string;
  runId: number | null;
  runLogPath: string;
  attempt: number;
  fingerprint: string;
  hostInstance: string;
  hostGeneration: number;
  dispatchKey: string | null;
  orchestratorId: string | null;
  createdAt: number;
}

/** Persistence bridge only: an identity is not proof that a process launched or stopped. */
export function reserveRunExecution(
  db: Db,
  runId: number,
  host: { instance: string; generation: number; attempt: number },
  now = Date.now(),
): RunExecutionIdentity {
  if (
    !Number.isSafeInteger(host.attempt) ||
    host.attempt < 1 ||
    !host.instance.trim() ||
    !Number.isSafeInteger(host.generation) ||
    host.generation < 1
  )
    throw new Error('Invalid execution host identity');
  db.exec('BEGIN IMMEDIATE');
  try {
    const run = db
      .prepare(
        `SELECT r.log_path, r.command_json, r.prompt, r.autonomy, r.provider_id,
      r.dispatch_key, r.orchestrator_id, p.path AS cwd FROM agent_runs r
      JOIN projects p ON p.id=r.project_id WHERE r.id=?`,
      )
      .get(runId);
    if (!run) throw new Error('Run not found');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          command: JSON.parse(run.command_json as string),
          prompt: run.prompt,
          autonomy: run.autonomy,
          provider: run.provider_id,
          cwd: run.cwd,
        }),
      )
      .digest('hex');
    db.prepare(
      `INSERT INTO agent_run_executions
      (nonce,run_id,run_log_path,attempt,fingerprint,host_instance,host_generation,dispatch_key,orchestrator_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,run_log_path,attempt) DO NOTHING`,
    ).run(
      randomUUID(),
      runId,
      run.log_path!,
      host.attempt,
      fingerprint,
      host.instance,
      host.generation,
      run.dispatch_key!,
      run.orchestrator_id!,
      now,
    );
    const identity = db
      .prepare(
        `SELECT nonce, run_id AS runId, run_log_path AS runLogPath, attempt,
      fingerprint, host_instance AS hostInstance, host_generation AS hostGeneration,
      dispatch_key AS dispatchKey, orchestrator_id AS orchestratorId, created_at AS createdAt
      FROM agent_run_executions WHERE run_id=? AND run_log_path=? AND attempt=?`,
      )
      .get(runId, run.log_path!, host.attempt) as unknown as RunExecutionIdentity;
    if (
      !identity ||
      identity.fingerprint !== fingerprint ||
      identity.hostInstance !== host.instance ||
      identity.hostGeneration !== host.generation
    )
      throw new Error('Execution identity already belongs to different launch arguments or host');
    db.exec('COMMIT');
    return identity;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
