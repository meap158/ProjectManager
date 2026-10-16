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

## Persistent bounded pipe output foundation, 2026-10-15

OutputLog was extracted unchanged into a shared module, with supervisor re-exports preserving
existing consumers. RunLauncher now writes through that same capped file/cache implementation
and exposes byte-offset reads, including stdout/stderr replay after reopening the journal.
Log paths are derived from a hash of the nonce under the host output directory, preventing a
nonce from choosing a filesystem path. The derived log path participates in launch replay
fingerprinting; a different output directory cannot silently relaunch the same nonce. Live
reads use the writer cache and finished runs release it; replay reads from bounded disk logs.
Ten focused log/delivery/real-launcher tests passed, plus server types and scoped lint.
Host socket capabilities, supervisor adoption, retention and platform containment remain open.

## Authenticated local run transport foundation, 2026-10-15

createRunServer now wraps the journal/launcher with a local socket request handler. A valid
hello token is required before launch/status/read/stop; token comparison is constant-time for
matching lengths. Strict schemas validate commands, nonces, timeouts and output cursors.
Connections, buffered frames, pending requests and queued response bytes are bounded, with
idle connections closed. Invalid requests with valid IDs receive correlated errors; missing
identity or unauthenticated/malformed traffic is disconnected. Capabilities advertise
pipe-runs-v1. A real Windows named-pipe fixture verifies unauthenticated stop rejection, wrong
token rejection, oversized frame disconnection, one actual worker launch despite replay,
completion polling, output reads and invalid cursor handling. The transport test, server
typecheck and scoped lint pass. It is not a standalone host daemon or supervisor integration:
authenticated rendezvous, unpredictable host instance propagation, startup/version selection,
OS socket permissions, process containment and production adoption remain open.

## Typed run-host client and reconnect evidence, 2026-10-15

RunClient authenticates hello, requires pipe-runs-v1/version 1, and exposes the host instance
for execution identity binding. It bounds outstanding calls and response framing, correlates
reply IDs, validates typed run/output results and rejects all pending requests on disconnect
or timeout. There is no automatic reconnect or launch replay; callers must inspect/replay the
same nonce explicitly. The real socket/worker fixture disconnects one client, reconnects a
second, confirms one launch marker, reads output and stops the same worker. Negative fixtures
reject an unsupported host and a silent host without sending launch. Three client tests,
server types and scoped lint pass; the server transport test also passed in the preceding run.
Standalone authenticated rendezvous/startup, actual host-process crash handling, supervisor
adoption and platform containment remain open.

## Standalone authenticated run host foundation, 2026-10-15

startRunHost and runHostMain now start the pipe-run service independently, with a fresh random
host instance and 32-byte random token, versioned rendezvous publication only after acquiring
the deterministic local address, and a private run-host directory/token file. Unix directory
and socket modes are explicitly restricted. Startup never unlinks an existing socket; competing
hosts fail without replacing credentials. Shutdown requests stop on owned live executions,
waits for close acknowledgements and keeps the host available if termination remains unknown.
The build's existing TypeScript inclusion emits the standalone entrypoint with the server.

Two actual lifecycle tests passed on Windows: competing-host/rendezvous protection and a
standalone host child retaining a real worker after a separate dispatch client process exits.
A new client replays that nonce without a second marker, then stops the same worker. Test
cleanup stops its worker before ending only its own daemon child. Server types and scoped
lint are checked separately. This is not supervisor adoption or host-crash containment. Unix
stale socket recovery intentionally refuses ambiguous ownership instead of unlinking a path;
platform validation, explicit stale-owner recovery, retention, production automatic startup,
execution-identity binding and typed supervisor reconciliation remain required.

## Host drain and canonical ownership, 2026-10-15

A lifecycle recheck found that shutdown could snapshot live workers while an existing client
launched another one. The server now enters drain mode synchronously before stopAll: launch
requests reject without reserving a nonce, while status/read/stop remain usable. An uncertain
stop does not reopen launch admission. Host socket names now derive from the real directory
path, case-folded on Windows, so alternate path casing cannot create a second address for the
same journal directory. Tests verify drain rejection without a claim and competing startup
through uppercase Windows paths. Five daemon/client tests passed, server types and scoped
lint passed. These fixes apply to the standalone host foundation; production supervisor
adoption and platform containment are still unimplemented.

## Run-attempt identity bridge, 2026-10-15

launchManagedRun now joins persisted production run identity to the authenticated host client.
It reserves the attempt nonce before launch, replays observed running/completed/unknown host
execution without launching again, and refuses to launch when an old execution is absent from
a replacement host's journal. Host identity mismatches reject. Lookup joins the current run's
log identity, preventing a reused row ID from attaching historical execution. A real host/worker
fixture verifies one launch marker, reattachment, terminal replay and no launch when replacement
ownership is unknown. Identity migration and bridge tests passed, plus server types/scoped lint.
The existing supervisor spawn/poll/reconcile loop does not call this bridge yet. Adoption still
requires persisted output cursors, current-worktree evidence rules, typed unknown lifecycle,
occupancy/retry controls and authenticated automatic host connection/startup.

## Shared production log identity, 2026-10-15

Journal schema 2 persists each execution's output path; initial/schema-1 journals upgrade
transactionally and retain claims. Managed launch binds the production run's immutable log
identity rather than duplicating host output into a second file. The host remains the writer;
reconnected reads use the journaled path. Explicit paths participate in the launch fingerprint
and claim conflict check. Legacy null paths retain derived-path read compatibility; no inferred
path grants a new launch. Clients require shared-run-log-v1 in addition to pipe-runs-v1 before
sending launch, avoiding accidental use of an older host with incompatible log ownership.
Seven journal/launcher/managed tests and six transport/client/daemon tests passed, along with
server types and scoped lint. The real managed worker test asserts the persisted run log
contains its output. Supervisor polling and lifecycle adoption, unknown occupancy and review
evidence handling remain unimplemented; no output mirroring/cursor recovery is claimed.

## Read-only managed execution observation, 2026-10-15

observeManagedRun now returns active/draining/complete/unknown states without launching work.
It verifies nonce, originating host and normalized persisted output path before reading output.
A terminal host result is not reported complete until bounded output reads reach the current
log end. Only then does exit code determine succeeded/failed outcome. Missing ownership,
mismatched output, absent output or a disconnected client yields unknown with no task outcome.
Real worker observation and closed-client behavior are covered alongside controlled multi-page
output/ownership mismatch tests. Two managed-run tests, server types and scoped lint passed.
This supplies the observation contract for supervisor adoption; it does not yet update run
rows, occupancy, review evidence or UI lifecycle state, and does not auto-reconnect or relaunch.

### Supervisor recovery integration

Persisted hosted attempts are observed on startup and every two seconds. Matching
run/log identities suppress legacy local relaunch and hold capacity while the host
is unavailable. Run details expose unknown execution explicitly. Stop requires an
authenticated host acknowledgment; an unconfirmed stop remains active and prevents
retry. Completion wakes queued work. Real-host tests cover startup adoption, a
single launch marker, acknowledged stop, terminal reconciliation and unavailable
host preservation. New dispatch routing and automatic host startup remain rollout
gates; this does not establish descendant containment or mobile validation.

### Project deletion ownership gate, 2026-10-16

The project DELETE route now awaits authenticated stop acknowledgments for owned
active runs before cascading project data. A missing/unreachable owner returns 409
and retains the project, run and execution identity. The storage DELETE independently
checks active owned runs in the same SQL statement, so an execution reserved during
the asynchronous preflight prevents deletion. Real-host API tests verify confirmed
termination before successful deletion and a still-running worker with all records
preserved when its host cannot be reached. Terminal journal identities remain as
history after the run foreign key is cleared by a successful cascade.

The next dispatch integration should reuse this lifecycle contract: connect to an
authenticated compatible host before reservation, persist intent before launch,
replay the same nonce after an uncertain reply, and never fall back to local spawn.
Automatic host startup must claim the deterministic socket before publishing its
credentials and must not remove an ambiguous Unix socket. New hosted dispatch remains
disabled pending its own real-process crash and review-evidence acceptance tests.

### Automatic connection foundation, 2026-10-16

connectRunHost authenticates published credentials and verifies the returned host
instance and capabilities before returning a client. An absent rendezvous permits
one startup flight per canonical data directory; concurrent callers wait through
credential publication. Any existing malformed credentials, failed authentication,
identity mismatch or absent published socket rejects without replacing ownership.
Failed startup flights release their in-process guard for a later explicit retry.

The default startup uses a hidden detached intermediate and the development tsx or
built JS entrypoint, following the existing session-host launch convention. Focused
connection tests inject a controlled real host to verify startup sharing, reuse,
failure release and refusal to replace broken credentials/socket ownership. The
existing daemon test separately proves child-owned worker survival. The new default
intermediate launch itself still needs a real-process integration test, and this
helper is not yet wired into supervisor dispatch. No production rollout is claimed.

### Opt-in supervisor dispatch, 2026-10-16

AgentSupervisor now accepts an internal `managedRuns` option (default false). This
path uses the authenticated connection helper, revalidates the current run/log and
active status after connecting, then reserves the attempt before host launch.
Missing runtime/authentication before reservation fails explicitly without local
spawn. A lost launch response after reservation preserves active occupancy with
unknown execution. Shutdown detaches; the next supervisor observes the same attempt.
Unsupported CPU-budget enforcement rejects before launch instead of silently ignoring
that setting. Legacy/manual routing is unchanged when this option is absent.

Three real-worker dispatch tests verify one marker and one charged attempt through
supervisor shutdown/recovery, host-confirmed stop, failed authentication with no
local worker, and a deliberately lost launch acknowledgment recovering unknown to
active. The broader host/installer/process-recovery group passed 44 tests before the
additional lost-reply case; the updated dispatch file passes all three. Server types
and scoped lint pass. This is not a fresh full-suite run after dispatch integration.

The option is not enabled by createApp/production configuration. Default intermediate
startup still needs direct real-process coverage, hosted change snapshots/review
evidence need implementation, and CPU budgets and platform containment remain gates
before default dispatch rollout. No historical worktree diff is invented on recovery.

### Persisted hosted review evidence, 2026-10-16

New hosted attempts capture a bounded immutable Git baseline before host submission,
keyed by attempt nonce and recording the working directory and capture time. Replay
never substitutes a later snapshot. Completion compares the current tree with that
saved baseline and stores the result with both observation timestamps. Completed
results remain fixed on subsequent polls. Missing/unavailable old baselines stay
null rather than manufacturing a historical diff. The review UI labels comparisons
as shared-worktree interval evidence that may include other authors' changes.

A real Git/worker test reopens the database before reconciliation, preserves an
unchanged pre-existing dirty file, finds the worker's new file and confirms later
edits cannot rewrite the saved result. Existing-schema upgrade/reopen leaves old
runs untouched with no invented evidence. Shutdown now awaits hosted setup and
revalidates launch after asynchronous capture; a paused-capture test proves no
worker starts after shutdown. Six evidence/dispatch tests, client/server types and
scoped lint pass. The preceding broader host/database group passed 34 tests before
the final shutdown/upgrade tests were added; no new whole-suite pass is claimed.

This is a bounded worktree comparison using the existing status/mtime/size algorithm,
not exclusive authorship or content-level provenance. Snapshot failures remain
unavailable evidence. Default intermediate startup, CPU budgets, containment and
production opt-in configuration remain open rollout work.

### Real automatic startup evidence, 2026-10-16

The default connectRunHost launch path is now exercised from a separate Node caller
process, using the real hidden detached intermediate and source entrypoint. That
caller launches a fixture worker and exits. A new client authenticates the published
instance, replays the nonce and observes one launch marker before host-confirmed stop.
The rendezvous now includes an optional validated positive PID for diagnostics only;
production ownership and stop still use authenticated nonce/instance state, never PID.
The fixture uses only its fresh private directory's PID for teardown, waits for that
daemon to disappear, and asynchronously waits for Windows handle release before cleanup.

Ten automatic-connection/daemon/supervisor tests, server types and scoped lint pass
on this Windows environment. This closes the missing default-intermediate test here,
not Unix/platform containment, CPU enforcement, all crash boundaries, production
configuration or physical mobile controls. Default hosted dispatch remains disabled.

### CPU budget before hosted worker startup, 2026-10-16

Opt-in hosted dispatch now wraps budgeted commands in an owned bootstrap. It applies
the saved thread budget and priority to itself, verifies its own resulting OS affinity
and priority, and only then creates the real worker with inherited settings. Invalid,
unsupported or unverified configuration exits without starting the worker. The wrapper
and command arguments participate in the host's ordinary immutable launch fingerprint;
stop/timeout still address the owned root and its process tree. No persisted PID is
used to adopt or configure a worker.

A Windows real-process probe confirms the worker sees the expected mask and
BelowNormal priority on its first command, and preserves its exit code. Invalid
budget input proves the target command is not executed. Budget-enabled supervisor
launch/recovery/stop is also covered; seven bootstrap/dispatch tests, server types
and scoped lint pass. Linux verification is implemented against /proc affinity and
process priority but has not been run here. The prior blanket CPU-enabled launch
rejection is removed only for the internal opt-in path.

Changing the budget of already-running hosted workers is still not wired into
Settings refresh. That and platform containment remain rollout gates, as do the
remaining crash matrix and production configuration. No default enablement or
fresh full-suite pass is claimed by these focused checks.

### Live Settings CPU refresh, 2026-10-16

The host advertises cpu-budget-refresh-v1 and accepts an authenticated bounded
cpu-budget request. RunLauncher collects only current live ChildProcess roots;
completed or old-host journal PIDs are never used. The existing tree limiter updates
those roots and descendants and returns owned-root and updated-process counts.
Supervisor Settings refresh connects only to the published host, validates instance,
and sends the saved budget; it never starts a replacement during refresh. Unavailable
or older hosts produce an explicit diagnostic while retaining their executions.

The Windows integration changes the saved setting, calls supervisor refresh, and
checks affinity and BelowNormal priority on both the owned wrapper and actual worker.
After stop, refresh reports zero owned/updated processes. A legacy-capability test
verifies no unsupported operation is sent. Ten dispatch/client/server tests passed;
the final descendant-enhanced dispatch test file passes all five tests. Server types
and scoped lint pass. Refresh retains the existing limiter's best-effort OS semantics:
counts do not establish that every descendant was updated, and failures remain visible
in diagnostics. Unix execution, containment, full crash acceptance, production
configuration and physical mobile controls are still open.

### Real host crash with a surviving worker, 2026-10-16

A new Windows fixture launches a real daemon and independently marked worker, kills
only that daemon abruptly, and confirms the worker remains alive. A replacement host
projects its old journal entry as unknown. Managed replay returns that unknown attempt
without launching. Supervisor startup preserves attempts/validation, holds the sole
capacity slot, leaves another run queued, refuses retry and refuses an unconfirmed stop.
The launch marker remains one. Cleanup terminates only the fixture's independently
observed worker; production never adopts or terminates a journal PID.

The case passes on Windows. It proves conservative unknown handling after an actual
host crash, not containment or exactly-once external effects. Unix stale sockets remain
conservatively nonreplaceable and need their own acceptance case. Other crash boundaries,
explicit user resolution of unknown execution and default production enablement remain
open. A new full-suite process was started after these focused changes; its final result
must be recorded separately rather than inferred from this one passing case.

The subsequent complete direct Vitest run passed 631 tests / 125 files in 157.75s
with exit code 0, including this crash test and preceding hosted/evidence/CPU work.
That result closes the current direct regression gate, while the remaining rollout
and physical/platform requirements above stay open.

### Explicit manual unknown resolution, 2026-10-16

Run details now offer a separate confirmation for unknown execution. The dialog
states that the user must independently verify and stop the worker outside the app;
opening it sends nothing and Cancel receives focus. Confirming submits the exact
attempt nonce and explicit worker-stopped attestation. A changed nonce unmounts any
open confirmation. Run actions wrap on small screens.

The supervisor observes the owner again before resolving. A now-known live or
completed execution, stale nonce or already-resolved row rejects. Only an active
unknown row matching the latest immutable run/log/attempt identity can transition.
The persisted resolution records manual-confirmation, nonce and timestamp. It frees
execution capacity as an unvalidated failed outcome, not success or host-confirmed
termination. Card review/validation is unchanged and logs/evidence remain intact.
No worker is killed and no replacement is launched by the resolution request itself;
already-queued unrelated work may use the released slot.

Twenty UI/API/managed/crash/evidence/assignment tests pass, with client/server types
and scoped lint. The real crash test independently stops its fixture worker before
attesting. API tests require the explicit attestation and reject stale/double requests;
a live-owner test rejects stale unknown UI state. Physical mobile dialog review and
the remaining platform/crash/production gates remain open. The previous 631-test full
run predates this manual-resolution change; no new full-suite pass is claimed here.
