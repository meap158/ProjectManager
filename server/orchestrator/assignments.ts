import type { Db } from '../db.js';
import { randomUUID } from 'node:crypto';
export class OrchestratorAssignments {
  constructor(private db: Db) {}

  currentLease(): { owner: string; expires_at: number; epoch: number } | null {
    return (
      (this.db
        .prepare('SELECT owner, expires_at, epoch FROM orchestrator_lease WHERE id = 1')
        .get() as { owner: string; expires_at: number; epoch: number } | undefined) ?? null
    );
  }

  isLeaseValid(owner: string, epoch?: number, now = Date.now()): boolean {
    const lease = this.currentLease();
    if (!lease || lease.owner !== owner || lease.expires_at <= now) return false;
    if (epoch !== undefined && lease.epoch !== epoch) return false;
    return true;
  }

  lease(owner: string, now = Date.now()): boolean {
    const existing = this.currentLease();
    if (!existing) {
      return (
        this.db
          .prepare(
            'INSERT INTO orchestrator_lease (id, owner, expires_at, epoch) VALUES (1, ?, ?, 1)',
          )
          .run(owner, now + 120000).changes > 0
      );
    }
    if (existing.owner === owner && existing.expires_at > now) {
      return (
        this.db
          .prepare('UPDATE orchestrator_lease SET expires_at = ? WHERE id = 1 AND owner = ?')
          .run(now + 120000, owner).changes > 0
      );
    }
    if (existing.expires_at <= now) {
      return (
        this.db
          .prepare(
            'UPDATE orchestrator_lease SET owner = ?, expires_at = ?, epoch = epoch + 1 WHERE id = 1 AND expires_at <= ?',
          )
          .run(owner, now + 120000, now).changes > 0
      );
    }
    return false;
  }

  renew(owner: string, epoch?: number, now = Date.now()): boolean {
    if (!this.isLeaseValid(owner, epoch, now)) return false;
    if (epoch !== undefined) {
      return (
        this.db
          .prepare(
            'UPDATE orchestrator_lease SET expires_at = ? WHERE id = 1 AND owner = ? AND epoch = ?',
          )
          .run(now + 120000, owner, epoch).changes > 0
      );
    }
    return (
      this.db
        .prepare('UPDATE orchestrator_lease SET expires_at = ? WHERE id = 1 AND owner = ?')
        .run(now + 120000, owner).changes > 0
    );
  }

  release(owner: string, epoch?: number) {
    if (epoch !== undefined) {
      this.db
        .prepare('UPDATE orchestrator_lease SET expires_at = 0 WHERE owner = ? AND epoch = ?')
        .run(owner, epoch);
    } else {
      this.db.prepare('UPDATE orchestrator_lease SET expires_at = 0 WHERE owner = ?').run(owner);
    }
  }

  retryPlans(now = Date.now(), cardIds?: readonly number[]) {
    if (cardIds?.length === 0) return new Map();
    const rows = this.db
      .prepare(
        'SELECT card_id, state, attempts, retry_after FROM orchestrator_assignments' +
          (cardIds ? ` WHERE card_id IN (${cardIds.map(() => '?').join(',')})` : ''),
      )
      .all(...(cardIds ?? [])) as {
      card_id: number;
      state: string;
      attempts: number;
      retry_after: number;
    }[];
    return new Map(
      rows.map((row) => [
        row.card_id,
        {
          attemptsUsed: row.attempts,
          attemptsRemaining: Math.max(0, 3 - row.attempts),
          retryAt: row.retry_after > now ? new Date(row.retry_after).toISOString() : null,
          blocker:
            row.state === 'dispatching'
              ? 'Dispatch acknowledgement pending'
              : row.state === 'assigned'
                ? 'Existing assignment requires completion or review'
                : row.attempts >= 3
                  ? 'Retry budget exhausted'
                  : row.retry_after > now
                    ? 'Retry cooldown'
                    : null,
        },
      ]),
    );
  }

  /** Reserved/cooling-down cards must not consume proposed capacity for ready work. */
  blockedCards(now = Date.now()): Set<number> {
    const rows = this.db
      .prepare(
        "SELECT card_id FROM orchestrator_assignments WHERE state != 'error' OR retry_after > ? OR attempts >= 3",
      )
      .all(now) as { card_id: number }[];
    return new Set(rows.map((row) => row.card_id));
  }

  claim(
    cardId: number,
    orchestratorId: string,
    now = Date.now(),
    owner?: string,
    epoch?: number,
  ): boolean {
    if (owner !== undefined && !this.isLeaseValid(owner, epoch, now)) {
      return false;
    }
    return (
      this.db
        .prepare(
          `INSERT INTO orchestrator_assignments (card_id, orchestrator_id, state, attempts, updated_at, dispatch_key)
      VALUES (?, ?, 'dispatching', 1, ?, ?)
      ON CONFLICT(card_id) DO UPDATE SET orchestrator_id = excluded.orchestrator_id, state = 'dispatching',
      attempts = orchestrator_assignments.attempts + 1, updated_at = excluded.updated_at,
      dispatch_key = excluded.dispatch_key, run_id = NULL
      WHERE orchestrator_assignments.state = 'error' AND orchestrator_assignments.retry_after <= ?
      AND orchestrator_assignments.attempts < 3`,
        )
        .run(cardId, orchestratorId, now, randomUUID(), now).changes > 0
    );
  }

  dispatchKey(cardId: number): string | undefined {
    return (
      (this.db
        .prepare('SELECT dispatch_key FROM orchestrator_assignments WHERE card_id = ?')
        .get(cardId)?.dispatch_key as string | null) ?? undefined
    );
  }

  assigned(
    cardId: number,
    runId: number,
    owner?: string,
    epoch?: number,
    now = Date.now(),
  ): boolean {
    if (owner !== undefined && !this.isLeaseValid(owner, epoch, now)) {
      return false;
    }
    return (
      this.db
        .prepare(
          "UPDATE orchestrator_assignments SET state = 'assigned', run_id = ?, updated_at = ? WHERE card_id = ?",
        )
        .run(runId, now, cardId).changes > 0
    );
  }

  /** Refund only an intent proven not to have inserted a run. Never refund real execution. */
  superseded(cardId: number, dispatchKey: string, owner: string, epoch: number, now = Date.now()) {
    if (!this.isLeaseValid(owner, epoch, now)) return false;
    return (
      this.db
        .prepare(
          `UPDATE orchestrator_assignments
      SET state = 'error', attempts = MAX(0, attempts - 1), retry_after = 0, updated_at = ?
      WHERE card_id = ? AND state = 'dispatching' AND dispatch_key = ?
      AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE dispatch_key = ?)`,
        )
        .run(now, cardId, dispatchKey, dispatchKey).changes > 0
    );
  }

  failed(cardId: number, now = Date.now(), owner?: string, epoch?: number) {
    if (owner !== undefined && !this.isLeaseValid(owner, epoch, now)) return false;
    this.db
      .prepare(
        "UPDATE orchestrator_assignments SET state = 'error', retry_after = ?, updated_at = ? WHERE card_id = ?",
      )
      .run(now + 300000, now, cardId);
    return true;
  }

  /** Reconcile a crash between run creation and recording its id; recover orphan dispatches without blind redispatch. */
  reconcile(
    runs: {
      id: number;
      cardId: number | null;
      createdAt: string;
      status?: string;
      validation?: string | null;
    }[],
    now = Date.now(),
  ) {
    // 1. Stable identity survives a crash after insertion but before acknowledgement.
    this.db
      .prepare(
        `UPDATE orchestrator_assignments AS a
      SET state = 'assigned', run_id = (SELECT r.id FROM agent_runs r WHERE r.dispatch_key = a.dispatch_key), updated_at = ?
      WHERE a.state = 'dispatching' AND a.dispatch_key IS NOT NULL
      AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.dispatch_key = a.dispatch_key AND r.card_id = a.card_id)`,
      )
      .run(now);

    // 2. Legacy timestamp fallback for runs without a dispatch_key
    for (const run of [...runs].sort((a, b) => a.id - b.id)) {
      if (run.cardId !== null)
        this.db
          .prepare(
            "UPDATE orchestrator_assignments SET state = 'assigned', run_id = ?, updated_at = ? WHERE card_id = ? AND state = 'dispatching' AND dispatch_key IS NULL AND updated_at <= ?",
          )
          .run(run.id, now, run.cardId, Date.parse(run.createdAt));
    }

    // 3. Orphan dispatch recovery:
    // If a crash occurred before run insertion, dispatching claims older than 120s with no matching
    // run in agent_runs are recovered to 'error' cooldown so retry budget applies.
    const DISPATCH_TIMEOUT_MS = 120000;
    this.db
      .prepare(
        `UPDATE orchestrator_assignments
      SET state = 'error', retry_after = ?, updated_at = ?
      WHERE state = 'dispatching' AND updated_at < ?
      AND (
        dispatch_key IS NULL
        OR NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.dispatch_key = orchestrator_assignments.dispatch_key)
      )`,
      )
      .run(now + 300000, now, now - DISPATCH_TIMEOUT_MS);

    // 4. Terminal lifecycle validation for assigned tasks
    const byId = new Map(runs.map((run) => [run.id, run]));
    const assigned = this.db
      .prepare(
        "SELECT a.card_id, a.run_id, c.status AS card_status FROM orchestrator_assignments a JOIN cards c ON c.id = a.card_id WHERE a.state = 'assigned'",
      )
      .all() as { card_id: number; run_id: number; card_status: string }[];
    for (const claim of assigned) {
      const run = byId.get(claim.run_id);
      // Review remains reserved. Only explicit rejection or reopening a validated task
      // to Todo permits a new attempt, and the persisted budget still applies.
      if (
        !run ||
        !['succeeded', 'failed'].includes(run.status ?? '') ||
        claim.card_status !== 'todo'
      )
        continue;
      if (run.validation === 'rejected' || run.validation === 'accepted') {
        this.db
          .prepare(
            "UPDATE orchestrator_assignments SET state = 'error', retry_after = 0, updated_at = ? WHERE card_id = ? AND state = 'assigned' AND run_id = ?",
          )
          .run(now, claim.card_id, claim.run_id);
      }
    }
  }
}
