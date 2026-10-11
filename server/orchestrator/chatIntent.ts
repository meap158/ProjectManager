import type { Db } from '../db.js';
import { OrchestratorAssignments } from './assignments.js';

/** Durable manual intent shares scheduler reservations and retry budgets. */
export class ChatDispatchIntent {
  readonly key: string;
  private assignments: OrchestratorAssignments;
  constructor(
    private db: Db,
    readonly cardId: number,
    orchestratorId: string,
    now = Date.now(),
  ) {
    this.assignments = new OrchestratorAssignments(db);
    if (!this.assignments.claim(cardId, orchestratorId, now))
      throw new Error('Task is reserved or its retry cooldown/budget has been reached');
    this.key = this.assignments.dispatchKey(cardId)!;
  }
  current(): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM orchestrator_assignments WHERE card_id = ? AND dispatch_key = ? AND state = 'dispatching'",
      )
      .get(this.cardId, this.key);
  }
  heartbeat(now = Date.now()): boolean {
    return (
      this.db
        .prepare(
          "UPDATE orchestrator_assignments SET updated_at = ? WHERE card_id = ? AND dispatch_key = ? AND state = 'dispatching'",
        )
        .run(now, this.cardId, this.key).changes > 0
    );
  }
  assigned(runId: number, now = Date.now()): boolean {
    return (
      this.db
        .prepare(
          "UPDATE orchestrator_assignments SET state = 'assigned', run_id = ?, updated_at = ? WHERE card_id = ? AND dispatch_key = ? AND state = 'dispatching' AND EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND card_id = ? AND dispatch_key = ?)",
        )
        .run(runId, now, this.cardId, this.key, runId, this.cardId, this.key).changes > 0
    );
  }
  /** A denied insertion did no work: release only this current key, without charging a retry. */
  superseded(now = Date.now()): boolean {
    return (
      this.db
        .prepare(
          "UPDATE orchestrator_assignments SET state = 'error', attempts = MAX(0, attempts - 1), retry_after = 0, updated_at = ? WHERE card_id = ? AND dispatch_key = ? AND state = 'dispatching' AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE dispatch_key = ?)",
        )
        .run(now, this.cardId, this.key, this.key).changes > 0
    );
  }
  failed(now = Date.now()): boolean {
    // Inserted work must be reconciled, even if acknowledgement failed.
    return (
      this.db
        .prepare(
          "UPDATE orchestrator_assignments SET state = 'error', retry_after = ?, updated_at = ? WHERE card_id = ? AND dispatch_key = ? AND state = 'dispatching' AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE dispatch_key = ?)",
        )
        .run(now + 300000, now, this.cardId, this.key, this.key).changes > 0
    );
  }
}
