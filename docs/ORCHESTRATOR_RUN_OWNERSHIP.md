# One-shot worker ownership and crash recovery

Status: implementation design, 2026-10-15. This is an open upgrade, not a claim that runs
already survive or stop reliably when their server exits. Owner: PM-64.

## Evidence and required behavior

`AgentSupervisor.spawnRun` uses detached `spawnPipe` processes. The run row has no authenticated
process owner. On restart, queued/running rows are relaunched while attempts remain; exhausted
rows become failed/unvalidated. The real process fixture confirms a worker can survive its
supervisor. Assignment/dispatch keys deduplicate rows, not external side effects.

Existing sessions use HostClient's authenticated local socket and a key combining row ID with
log path, avoiding SQLite ID reuse. However, HostedProc is PTY-specific, and host generation 3
kills orphan sessions after its grace period. Reusing that host unchanged for runs would change
CLI pipe behavior and silently inherit a terminal-specific orphan policy.

The required invariant is: recovery must not launch a second attempt until the prior attempt's
owner authoritatively reports it ended, or the user explicitly resolves unknown execution.
A stored PID, elapsed timeout, missing log output or unreachable socket does not prove exit.

## Chosen architecture

Extend the authenticated host infrastructure with an explicit pipe-run capability and a
separate protocol generation. Keep existing PTY session lifecycle semantics unchanged. Require
capability negotiation before sending a run request; an old host must never receive a request
that falls back to a PTY or a duplicate local launch. If hosting is unavailable, a managed
Orchestrator dispatch waits with a typed provider/runtime blocker rather than launching an
unrecoverable detached process. Decide separately whether manual runs may opt into legacy mode.

Persist run execution identity before launch: a cryptographic attempt nonce, host generation,
host instance identity and immutable dispatch/request linkage. The host addresses work by that
nonce, not by row ID or PID, and binds it to a command fingerprint and working directory. A
repeated launch with matching nonce/arguments returns the existing attempt, including terminal
state; conflicting arguments reject. A completed nonce must not silently spawn again.

The host durably journals launch claims, process startup and terminal status. A host crash after
claim but before known startup yields unknown execution unless the OS containment primitive
proves all descendants ended. Do not represent an in-memory Map alone as durable ownership.
Use platform containment where available; Windows Job Objects and Unix process groups require
separate verification and cannot be treated as equivalent merely because taskkill works.

## Recovery state transitions

| Persisted/observed state              | Recovery action                                           | New attempt allowed?            |
| ------------------------------------- | --------------------------------------------------------- | ------------------------------- |
| Intent exists; no launch claim        | Revalidate scope/revision/quota and claim the same intent | After revalidation              |
| Host reports attempt running          | Reattach output and stop controls; preserve attempt count | No                              |
| Host reports completed                | Reconcile exit/change evidence; require normal review     | No automatic replacement        |
| Host explicitly reports never started | Retry same launch nonce after revalidation                | Same attempt only               |
| Host unreachable or identity mismatch | Show execution unknown and preserve reservation           | No                              |
| Host proves process tree stopped      | Record interruption; apply review/retry policy            | Only through explicit policy    |
| Card or policy changed before launch  | Supersede intent and refund unused attempt                | New revision after revalidation |

Keep lifecycle state distinct from task outcome. Unknown execution is neither successful nor
an ordinary failed command. Stop must acknowledge actual host termination before clearing
occupancy/reservation. UI status and retry enablement consume that typed state; do not inspect
English error strings. Preserve old logs and review evidence when recovering a finished run.

## Delivery sequence and acceptance evidence

1. Add append-only execution identity/journal schema and protocol capability types. Upgrade an
   existing database; retain legacy row behavior explicitly without inventing an owner.
2. Implement pipe host spawn/replay, bounded output offsets and terminal journal retention.
   Verify stdout/stderr, EOF, command arguments, environment, timeout and stop behavior on
   Windows and Unix. Preserve interactive session host generation compatibility.
3. Integrate supervisor insertion/launch acknowledgement and startup reconciliation. Claim the
   execution identity before any OS launch; replay must not increment attempt counters.
4. Add typed execution-unknown status to API, planner occupancy and review/Retry controls.
   Unknown work remains visible and blocks conflicting workers on its card/project.
5. Crash real supervisors and hosts before claim, after claim, after OS spawn, before startup
   persistence, during execution, after exit and before acknowledgement. Use fixture workers
   with independently observable launch markers and side effects, and verify process identity
   via live handles rather than database rows. Test lost response, duplicate request, changed
   arguments, reused row ID, stale host generation and reconnect during stop.
6. Verify no duplicate work for every proven recovery case. Explicitly report unknown cases;
   never claim exactly-once external effects where host/OS evidence cannot establish it.
   Measure recovery/attach latency and host memory/log bounds. Run the repository regression
   and physical desktop/mobile controls before enabling hosted runs by default.

Scheduler durable request identity and task generations remain separate requirements: request
identity survives retries, while every permitted attempt receives its own execution nonce.
The current random assignment dispatch key supplies neither relationship by itself.

## Implemented foundation, 2026-10-15

The append-only agent_run_executions migration and reserveRunExecution persistence bridge now
record an immutable nonce per run/log identity and attempt, command/prompt/provider/autonomy/
working-directory fingerprint, host instance/generation and dispatch/master linkage. Replaying
the same reservation returns the original identity. Changed launch arguments or host identity
reject within a write transaction. Deleting a run preserves the historical nonce with a null
run reference; a reused SQLite ID receives a distinct identity. Legacy runs are not backfilled
with invented owners. Existing-database upgrade/reopen, conflicting reservation rollback and
retry identity are covered by tests. The bridge is not yet used by production launch code:
host capability negotiation, durable host launch journal, typed lifecycle state and recovery
integration remain required before it can provide process ownership guarantees.
