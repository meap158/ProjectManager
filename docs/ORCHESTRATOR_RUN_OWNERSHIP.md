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

## Host journal foundation, 2026-10-15

RunJournal now persists nonce/fingerprint launch claims and terminal results in a separate
SQLite WAL journal with synchronous=FULL. Only the first committed claim returns launch=true.
A repeated nonce with different arguments rejects. Startup under a different host instance
projects claimed/running entries as execution unknown, never permits a second launch and
cannot overwrite the original owner's result. The original live host can still report an
actual exit. Terminal results are retained across restarts, and late duplicate callbacks
cannot rewrite them. PIDs remain diagnostic metadata only.

Tests include a child that commits claimed/running/finished entries then exits without closing
the journal, plus two competing journal connections. Together with execution-identity upgrade
coverage, three tests passed; server types and scoped lint were checked separately. This is
storage/state-transition coverage, not a hosted OS launch test. Journal schema migration and
retention, unpredictable per-boot host identity, capability negotiation, pipe execution,
bounded host transport and supervisor integration remain open. No production process launch
uses this journal yet, so its existence alone does not close the orphan-worker recovery gap.

## Journal-backed pipe launcher, 2026-10-15

RunLauncher now connects a committed journal claim to an actual shell-free detached pipe
spawn. It fingerprints argv, cwd and ordered environment entries locally rather than trusting
a caller-supplied fingerprint. Duplicate nonces replay the journal without spawning, including
completed and unknown attempts; changed arguments reject. Exit is recorded on close after
stdout/stderr drain. Spawn errors remain terminal journal results, and synchronous exceptions
conservatively retain unknown execution. Viewer callback errors do not terminate the worker.
Real fixture tests verify one launch marker despite duplicate requests, stdout/stderr delivery,
terminal replay after reopening under a new host instance, conflicting arguments and spawn
failure replay. Four launcher/journal tests, server types and scoped lint passed.

The launcher is not yet reachable from a socket or the supervisor. Authenticated capability
negotiation, identity bridging, bounded persistent output, timeout/stop ownership, journal
migration/retention and actual host-crash containment remain required before production use.
Do not use this internal class as a claim that current Orchestrator workers are host-owned.

## Owned launcher stop and timeout foundation, 2026-10-15

RunLauncher now holds live ChildProcess handles, accepts a bounded execution timeout and offers
stop(nonce). It never looks up a stored PID for termination: only its currently live handle
permits a Windows taskkill tree request or Unix process-group signal. Stop waits for the root
process close acknowledgement; a missing acknowledgement records unknown execution. Timeout
uses the same stop path, and timeout settings participate in the command fingerprint. Unknown
or old-host journal entries cannot be stopped by guessing their PID. Real-process tests verify
stop/timeout completion, terminal replay, missing ownership and invalid timeout rejection.
Three launcher tests passed, with server types and scoped lint.

Root close and a process-group/tree termination request are not proof that every descendant
or external side effect ended. Escaped descendants, Unix containment behavior and OS identity
races still require the platform containment work in the acceptance matrix. This launcher is
still not connected to production supervisor/socket transport, and no existing run lifecycle
policy is changed by these foundations.

## Journal format compatibility, 2026-10-15

The journal now upgrades its initial unversioned format transactionally to schema version 1
without deleting launch tombstones. A newer schema version is refused before changing journal
settings or tables, and failed initialization closes the database handle. An existing-file
test verifies completed-claim replay after upgrade and unchanged data/version after a future
schema rejection. Three journal tests, server types and scoped lint passed. Host transport
and production lifecycle integration remain open; journal version compatibility alone is not
runtime capability negotiation.
