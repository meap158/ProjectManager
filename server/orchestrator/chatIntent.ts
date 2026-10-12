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
    request?: { id: string; fingerprint: string; revision: string },
  ) {
    this.assignments = new OrchestratorAssignments(db);
    if (request) db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.assignments.claim(cardId, orchestratorId, now))
        throw new Error('Task is reserved or its retry cooldown/budget has been reached');
      this.key = this.assignments.dispatchKey(cardId)!;
      if (request) {
        db.prepare(
          `INSERT INTO orchestrator_dispatch_requests
          (orchestrator_id, request_id, fingerprint, card_id, card_revision, dispatch_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          orchestratorId,
          request.id,
          request.fingerprint,
          cardId,
          request.revision,
          this.key,
          now,
        );
        db.exec('COMMIT');
      }
    } catch (error) {
      if (request) db.exec('ROLLBACK');
      throw error;
    }
  }
  static replay(db: Db, owner: string, id: string, fingerprint: string) {
    const row = db
      .prepare(
        `SELECT q.fingerprint, q.card_id, q.card_revision, r.id AS run_id,
      r.status AS run_status, a.state AS assignment_state
      FROM orchestrator_dispatch_requests q
      LEFT JOIN agent_runs r ON r.dispatch_key = q.dispatch_key
      LEFT JOIN orchestrator_assignments a ON a.dispatch_key = q.dispatch_key
      WHERE q.orchestrator_id = ? AND q.request_id = ?`,
      )
      .get(owner, id) as
      | {
          fingerprint: string;
          card_id: number;
          card_revision: string;
          run_id: number | null;
          run_status: string | null;
          assignment_state: string | null;
        }
      | undefined;
    if (!row) return null;
    if (row.fingerprint !== fingerprint)
      throw new Error('Request ID was already used with different dispatch arguments');
    return {
      requestId: id,
      cardId: row.card_id,
      cardRevision: row.card_revision,
      runId: row.run_id,
      status:
        row.run_status ?? (row.assignment_state === 'dispatching' ? 'pending' : 'interrupted'),
    };
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
