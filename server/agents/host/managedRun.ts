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
