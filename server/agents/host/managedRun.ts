import path from 'node:path';
import type { RunExecutionIdentity } from '../runExecution.js';
import type { Db } from '../../db.js';
import { findRunExecution, reserveRunExecution } from '../runExecution.js';
import { RunClient } from './runClient.js';
import type { PipeRunLaunch } from './runLauncher.js';

/** Bind production run identity before launch; reconnect never guesses that missing work stopped. */
export async function launchManagedRun(
  db: Db,
  client: RunClient,
  runId: number,
  attempt: number,
  launch: Omit<PipeRunLaunch, 'nonce' | 'logPath'>,
) {
  const previous = findRunExecution(db, runId, attempt);
  if (previous) {
    const observed = await client.status(previous.nonce);
    if (observed) {
      if (observed.hostInstance !== previous.hostInstance)
        throw new Error('Execution host identity mismatch');
      return { identity: previous, execution: observed };
    }
    if (previous.hostInstance !== client.hostInstance)
      throw new Error(
        'Execution ownership is unknown; the previous host must be resolved before relaunch',
      );
  }
  const identity = reserveRunExecution(db, runId, {
    instance: client.hostInstance,
    generation: 1,
    attempt,
  });
  const execution = await client.launch({
    ...launch,
    nonce: identity.nonce,
    logPath: identity.runLogPath,
  });
  if (execution.hostInstance !== identity.hostInstance)
    throw new Error('Execution host identity mismatch');
  return { identity, execution };
}

export interface ManagedRunObservation {
  phase: 'active' | 'draining' | 'complete' | 'unknown';
  outcome: 'succeeded' | 'failed' | null;
  output: Awaited<ReturnType<RunClient['read']>>;
  detail?: string;
}

/** Read-only: neither missing ownership nor a lost response can cause a new launch. */
export async function observeManagedRun(
  client: RunClient,
  identity: RunExecutionIdentity,
  after: number,
): Promise<ManagedRunObservation> {
  const unknown = (detail: string): ManagedRunObservation => ({
    phase: 'unknown',
    outcome: null,
    output: null,
    detail,
  });
  try {
    const execution = await client.status(identity.nonce);
    if (!execution || execution.state === 'unknown')
      return unknown('Execution ownership is unknown');
    const normalize = (file: string) =>
      process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    if (
      execution.nonce !== identity.nonce ||
      execution.hostInstance !== identity.hostInstance ||
      !execution.outputPath ||
      normalize(execution.outputPath) !== normalize(identity.runLogPath)
    )
      return unknown('Execution identity or output ownership mismatch');
    const output = await client.read(identity.nonce, after);
    if (!output) return unknown('Execution output is unavailable');
    if (execution.state !== 'exited') return { phase: 'active', outcome: null, output };
    if (output.nextOffset < output.totalBytes) return { phase: 'draining', outcome: null, output };
    return {
      phase: 'complete',
      outcome: execution.exitCode === 0 ? 'succeeded' : 'failed',
      output,
    };
  } catch (error) {
    return unknown((error as Error).message);
  }
}
