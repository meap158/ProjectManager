# Orchestrator audit and upgrade plan

Implementation status, revalidated 2026-10-16. This table summarizes verified behavior;
chronological findings below preserve earlier evidence and are not current completion claims.

| Area                     | Verified implementation                                                                                                                                                                             | Remaining acceptance work                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable execution        | Reservations, leases, heartbeats, insertion/revision fences, manual replay; opt-in authenticated hosted launch/replay, persisted logs and attempt identity, unknown occupancy and acknowledged stop | Scheduler request identity across attempts, durable task generations, remaining real crash boundaries, containment/platform checks, production enablement |
| Controls and convenience | Scoped Check now, paged preview/pending inspection, owner-isolated feeds, scoped chat selector, lifecycle controls; persisted pre-launch interval evidence and live hosted CPU refresh              | Physical mobile/browser review, actionable typed provider/auth recovery and physical review of manual unknown-execution resolution                        |
| Efficiency               | Indexed scoped SQL projections, narrow reconciliation, single-flight ticks, settled polling, round-robin fairness; unchanged hosted polls make zero row writes                                      | Dispatch/write-cost measurements, consolidated summary transport and end-to-end latency                                                                   |
| Follow-through           | Shared planner/quota/capacity/review policy, persisted retry budget/cooldown, attention episode dedup, explicit idle-worker messaging                                                               | Classified provider/auth recovery, task dependencies, provider preferences and bounded managed-worker reuse                                               |
| Evaluation               | Fresh direct whole-suite run: 631 tests / 125 files passed, exit 0; real hosted launch/evidence/CPU/crash acceptance included                                                                       | npm formatting gate in shared files, physical mobile/LAN and cross-platform execution                                                                     |

Planning reads only global live workers, latest eligible-card runs and last-served scoped
projects. Situation inspection loads scoped live and unreviewed work plus latest active-card
runs, excluding accepted history without a fixed history cutoff. Reconciliation loads only
assignment-linked rows; live occupancy reads distinct project IDs; attention result collection
compares exact indexed identities for its follow-up cards. OrchestratorService no longer
hydrates full run history. Query correctness tests retain global caps, pending review and
fairness semantics, including history exceeding 100,000 rows.

The measured 1k-card/100k-history situation builder median fell from 2,769.92ms to 12.51ms.
In isolated database fixtures, partial indexes reduced planning projection median from 9.49ms
to 0.53ms and live occupancy from 41.43ms to 0.02ms. See
[benchmark scope and reproduction](ORCHESTRATOR_BENCHMARK.md). These are synthetic component
measurements, not whole-request or mobile latency claims. The append-only production index migration is committed after the last-input schema change,
with an existing-database upgrade test. Run ownership is separately persisted and recoverable
assignment history is backfilled.

## Next upgrades and release evidence

1. **Finish durable request recovery.** Persist a request identity separate from each attempt,
   tied to master, card revision and requested provider/instructions. Replays return the existing
   pending/completed result; conflicting reuse rejects. Verify process termination before claim,
   after claim, after insertion and before acknowledgement using an isolated database and fake
   worker executable. Pass only if the same request creates at most one worker and recovery
   reports its actual state without consuming duplicate attempts.
2. **Make blocked work actionable.** Classify quota, authentication, unavailable provider,
   capacity, task readiness, pending review and exhausted retry budgets. Show the specific next
   action and effective permission mode beside the task. Authentication/configuration failures
   wait for correction; quota reset schedules fresh verification. Preserve explicit review and
   never send automatic input into manual terminals or permission prompts. Test policy changes,
   drafts, retry exhaustion and scoped result links before physical mobile review.
3. **Finish measured efficiency.** The tested partial indexes and upgrade migration are committed. Measure complete read-only inspection/preview and isolated dispatch ticks at
   1k/10k cards, 100k history and 1/5/20 masters: p50/p95, SQL/quota reads, writes, RSS and response
   bytes. Include many unreviewed runs and unscoped masters. Then introduce a versioned summary
   and paginated situation details where measured payloads require it. Preserve the current
   fresh insertion fence and populated-view/stale-response behavior.
4. **Evaluate follow-through after those gates.** Add evidence-linked review, task dependencies,
   provider preferences and bounded managed-worker reuse. Keep optional decomposition/planning
   separately budgeted. Compare validated completions, manual interventions and token cost;
   convenience must not weaken scope, permissions or review controls.

Full `npm run check` currently passes typechecking and lint but stops at formatting in shared
UI files, before the whole test suite. Those edits are owned by another agent and were not
included in the Orchestrator commits. Physical mobile and runtime crash evidence is missing.
The full upgrade is therefore not yet proven complete; the remaining gates above are explicit.

Audited against the current worktree on 2026-10-11. No masters were enabled and no
worker input was sent. Findings below derive from code; they are not live incident claims.

## Current implementation

The orchestrator is a deterministic board scheduler with persisted named policies,
project scope, provider preferences, concurrency limits, fresh-quota checks, review
exclusion, serialized ticks, SQLite lease/claims and optional Dashboard follow-up.
The UI supports Start/Pause, editing, Check now, board summaries, live workers and
filtered decision history. Paused masters avoid expensive inspections; recurring ticks
wait for completion. These foundations should remain.

## Initial prioritized findings (historical)

| Priority | Code evidence                                                                        | Consequence and upgrade                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | assignments.ts only retries error claims; assigned claims have no terminal lifecycle | Reopened/rejected tasks can remain reserved. Reconcile run validation/card state and persist explicit execution generations.                                                                  |
| P0       | dispatching recovery requires a later run                                            | A crash before run insertion can strand work. Persist dispatch intent and a stable idempotency key; reconcile orphan claims without blind redispatch.                                         |
| P0       | service.ts plans capacity before claim eligibility                                   | An old reserved card can consume the proposed slot and starve later work. Plan eligible claims and refill after failed claims.                                                                |
| P0       | 120s lease has no fencing and renews only around dispatch                            | Slow awaits can outlive ownership. Renew during operations and fence assignment transitions with owner epoch.                                                                                 |
| P1       | all running sessions count globally, including idle/manual/out-of-scope sessions     | Unrelated terminals can block work while UI shows scoped occupancy. Separate global safety cap, managed budget and external occupancy with explicit conflict rules.                           |
| P1       | per-instance Check now calls global tick                                             | One master's button can dispatch other masters. Add scoped checks and read-only preview; label Check all separately.                                                                          |
| P1       | manual ticks append to a promise chain                                               | Repeated checks queue redundant inspections. Coalesce checks and expose current operation status.                                                                                             |
| P1       | combined quota/provider/capacity wait reason                                         | Waiting lacks useful next steps. Return typed reasons, freshness, reset time, retry time and effective policy. Reset schedules fresh verification, never blind continue.                      |
| P1       | snapshots repeatedly load all cards and up to 100,000 runs per decision              | History growth multiplies SQL, conversion and quota-file reads. Use scoped indexed candidates, latest-run projections, precomputed counts and narrow pre-dispatch revalidation.               |
| P1       | UI requests four endpoints every 5s with setInterval                                 | Slow requests overlap and errors/stale data are hidden. Use versioned summary endpoint, settle-then-refresh and stale-response protection.                                                    |
| P1       | events rewrite whole settings JSON; dedup checks only last event                     | Alternating waits churn storage/history. Separate events/config and record transitions with per-card/reason dedup and bounded retention.                                                      |
| P1       | scheduler orders by position/time with no readiness/dependencies/fairness            | One project can dominate and incomplete tasks start. Add ready criteria, dependencies, bounded priorities and project round-robin.                                                            |
| P1       | dispatch defaults to edit autonomy; UI speaks generically about permissions          | Effective permissions are unclear. Show inherited/edit/read policy and never escalate on recovery.                                                                                            |
| P2       | no managed idle-worker reuse, stall recovery or scoped master planning tools         | Dispatch exists, but follow-through is limited. Add bounded follow-up after reliable lifecycle/review and observability.                                                                      |
| P2       | attention dedup uses signal kinds and defers on any running project session          | Idle terminals defer inspection; new dirty work can be hidden behind persistent signals. Track episodes/revisions and show deferred reasons; dirty status alone never authorizes commit/push. |

## Recommended experience

Each master should answer: what runs next, why it waits, what needs the user, and when
it checks again. Compact overview: actual ready/running/waiting/blocked/review status,
managed/external workers, ready-task count, quota readiness and last/next check.
Expand for policy/history. Provide exact card and worker links and a Needs attention queue.
Mobile uses collapsed details and 44px controls with no forced keyboard focus.

Creation starts with scope/provider preference; advanced fields hold concurrency,
freshness, reserve and recovery budgets. Preview has no side effects. Check now applies
only to that master. Pause stops new dispatch while existing workers continue.

Reuse only managed card-linked workers with verified idle state, empty input and provider
support. Never inject continue into arbitrary manual terminals, active execution,
permission/input prompts or authentication failures. Silence alone is not proof of a stall.
Completion requires validation evidence; process exit 0 never automatically accepts work.

## Delivery sequence and acceptance gates

1. **Durable lifecycle:** append-only migrations for execution identity, task generation,
   owner epoch and explicit reserved/starting/running/review/retry/blocked/completed states.
   Stable dispatch keys stored with runs. Reconcile before resuming; claim-aware planning.
   Test crashes before/after claim, run insertion and acknowledgement, reopened/rejected
   tasks, overlapping owners and dispatch exceeding lease TTL. No duplicate or stranded work.
2. **Explain and control:** typed wait reasons, scoped Check now, read-only Preview,
   effective permissions, managed/external worker counts and exact links. Test scope isolation,
   pause during dispatch and mobile navigation. Every blocked state offers a useful next step.
3. **Efficient scheduling:** single-flight ticks, indexed scoped queries, immutable planning
   snapshot, narrow fresh checks, debounced board/worker/quota wakeups with timer fallback,
   transition events and versioned UI summary. Benchmark 1k/10k cards, 100k run history and
   1/5/20 masters: tick p50/p95, SQL count, quota reads, writes, RSS and response bytes.
   Verify no overlapping polls, stale overwrites or unbounded event growth.
4. **Task/provider policy:** fair project scheduling, dependency/readiness checks, project
   provider preferences, explicit autonomy and visible external occupancy. Preserve one
   editing worker per shared project by default. Test starvation, dependencies, quota
   exhaustion and permission invariants.
5. **Follow-through:** evidence-linked review, classified transient retries with bounded
   exponential backoff/jitter, persisted budgets and idempotent nudges. Auth/config errors
   wait for correction. Test restart dedup, no input into drafts/prompts, exhausted budget
   visibility and safe provider-supported reuse.
6. **Optional planning intelligence:** scoped inspection/decomposition/dependency tools,
   structured plans validated by deterministic policy and separate planning budget.
   Invoke on ambiguous or newly blocked work rather than every tick. Evaluate validated
   completions per token, manual interventions and scope/tool-injection resistance.

Keep SQLite and the local server; no additional workflow infrastructure is needed.
Roll out phases separately with backward-compatible configs, migration tests and existing
review/permission gates. Do not enable previously paused masters during rollout.

## Verification and reference principles

Existing tests cover scope/quota/reservations, live/review exclusion, paused ticks,
timer restart, lease expiry, cooldown and post-run-insertion recovery, attention dedup
and UI summaries/history. They do not establish the missing lifecycle/recovery gates above.
Run targeted tests, full repository checks and browser/mobile verification for each phase.
Track validated completion rate, ready-to-dispatch delay, review/blocked age, duplicates,
recovery success, interventions, token spend and idle overhead. Establish baselines before
choosing numerical targets.

The simple deterministic workflow plus optional evaluated planning follows
[Anthropic's agent design guidance](https://www.anthropic.com/engineering/building-effective-agents).
Durable intent, classified retries, idempotency and failure testing follow
[Temporal best practices](https://docs.temporal.io/best-practices) and
[operation idempotency](https://docs.temporal.io/nexus/operations). These are design
references, not proposals to install a framework.

## Verified correction: attention dispatch policy

Manual attention resolution previously called dispatchCard directly, choosing any available CLI as a fallback and skipping quota, capacity and durable claims. It now creates/deduplicates follow-up cards and requests the existing serialized scheduler. Paused masters retain queued tasks; Observe proposes without dispatch. Configured provider selection, quota reserves, live-worker capacity and fenced claims apply equally. Tests cover pause, Observe, unavailable configured providers and assigned run persistence. The response reports newly started runs associated with the affected cards; task creation is not proof that an issue has been resolved.

## Lease fencing correction

Lease release now expires the persisted row instead of deleting its epoch. Reacquisition increments the epoch even for the same owner; expiry equality counts as expired. Renewal cannot resurrect an expired lease. Failure transitions validate the owner epoch so a slow old dispatcher cannot overwrite a newer assignment. Regression tests cover release/reacquire, stale release, stale failure, expired renewal and exact expiry boundaries. Dispatch-provider side fencing and long-running heartbeat coverage remain separate acceptance gates.

Long-running leased ticks now renew every 30 seconds and clear the heartbeat on completion. Tests simulate a three-minute provider wait, prevent takeover and prove release allows a competitor afterwards. Provider-side commit fencing remains to be verified.

Attention routes now validate scoped action bodies and dismissal kinds. Malformed JSON, invalid IDs and unknown kinds return 400 before side effects rather than defaulting to all projects. Regression coverage includes global and per-master endpoints. Twenty-seven Orchestrator tests and server types pass.

Project fairness now alternates board-ordered queues and prefers projects with the oldest latest card-run identity. Unserved projects come first. Existing history provides cross-tick ordering without added state writes. Global capacity includes proposed dispatches so previews respect the 32-worker cap. Tests cover alternate projects, cross-tick preference, board ordering and proposed capacity. Fairness is limited by the available run snapshot; full long-history projection/benchmark work remains open.

Idle scheduling efficiency: waiting/review decisions no longer reload full history, all cards and quota files per card. Snapshot card queries honor the initial master scope. Dispatch proposals still revalidate fresh policy/live state before claiming. A 100-review-card regression test verifies exactly two run-history reads instead of 102; newly eligible waits are handled on the next check. Full dispatch-heavy benchmarks and indexed latest-run projections remain open.

Event history now records per-card observation transitions: unchanged wait/review/Observe decisions preserve their original timestamp and skip settings writes, even when other cards interleave. Actual operations remain recorded. Tests verify repeated 100-card checks preserve history and strategy transitions remain visible. Separate event storage and retention-aware projection are still future efficiency work.

UI stale-response protection verified: polling uses a refresh epoch and skips while actions execute. Older poll results cannot overwrite action refresh; duplicate action entry is guarded. Nine page tests and client types/lint pass. Full repository verification remains incomplete after an out-of-memory failure during lint.

Commit fencing: supervisor canCommit runs synchronously before insertion, after asynchronous provider checks; Orchestrator supplies current lease and enabled/strategy/provider/scope checks. A denied fence produces no run. Repeated-key second lookup checks task identity. Forty-nine focused agent/Orchestrator tests and server typecheck pass. Full suite remains running with one worker.

Full regression suite: 355 tests / 76 files pass with one worker. Final commit validation now rechecks quota, capacity and current card readiness, excluding only the owned dispatch reservation. Service test exercises capacity changing while dispatch is pending. Full runtime/mobile, benchmarks and repository lint/format/build gates remain open.

Pure planner benchmark added in scripts/benchmark-orchestrator.mjs and docs/ORCHESTRATOR_BENCHMARK.md. 10k cards/100k history: one-master p50 22.84ms; 20-master batch p50 393.85ms. Decision array alone is 1,854,399 bytes/master. Prioritize compact summaries and paginated details for mobile; end-to-end SQL/quota/transport measurements remain open.

## Current convenience and transport improvements

Quick runs select a master and project, reuse deduplicated Dashboard follow-up cards and
check that master's policy-controlled board queue. Persistent results distinguish queued
cards from dispatched runs and link to their tasks. Paused and Observe settings are preserved.
The quick action checks the master's whole board queue; it is not an isolated project scheduler.

Preview responses now include whole-queue dispatch/review/wait counts and return 100 tasks
by default, maximum 200 with validated pagination. This addresses the measured multi-megabyte
mobile response/render issue. Planning still loads the full snapshot and computes all decisions;
indexed latest-run projections and end-to-end SQL/quota benchmarks remain open. Each page is
a fresh read-only snapshot, so changing queues can shift tasks between pages.

## Task revision race protection

Dispatch now captures the card's instructions and update timestamp before asynchronous
provider preparation. The existing synchronous insertion fence rejects changed content,
status or timestamp, preventing a stale prompt from launching after an edit. Tests exercise
same-timestamp content changes and revision-only changes alongside capacity races.
This is in-flight protection, not a durable generation counter: edits reverted to identical
content/timestamp and crash-spanning task revisions still require the planned generation work.
Superseded pre-launch intents now release their reservation with zero cooldown and refund
that intent's attempt. The transition is fenced by current lease epoch, dispatch key and
absence of any inserted run carrying that key. A second refund or a stale owner/key cannot
change accounting; an inserted run stays reserved and counted. Replanning occurs on the
next tick, not an immediate retry loop. Tests cover edited-task redispatch, duplicate refund,
wrong owner/key and crash-after-insertion protection. Durable revision identities and
classified provider/auth failures remain separate recovery work.

## Situation builder efficiency

Worker and card-attention lookup now uses one-pass indexes, removing cards-by-history and
cards-by-attention scans. The full synthetic output matches the earlier builder, with existing
scope/context tests passing. The 1k-card/100k-history benchmark improves median builder time
from 2,769.92ms to 12.51ms. This closes a measured computation bottleneck, while indexed SQL
history projection, bounded situation responses and actionable UI remain open.

Planner preview and dispatch snapshots now use a narrow SQLite projection for global live
workers, latest eligible-card runs and last-served scoped projects. A database regression
compares complete planner decisions with the full-history input. Attention busy checks and
resolve-result collection still use history lists; query-plan and end-to-end benchmarks remain
required before claiming broad performance completion.

Dashboard attention occupancy now reads distinct live-run project IDs from SQLite, preserving
running-session occupancy and removing historical payload hydration and the history cutoff.
Resolve-result collection remains the last full-history use in OrchestratorService.

Resolve attention compares indexed run identities only for its follow-up cards before and
after the tick. Exact ID sets handle deletion/reuse correctly. OrchestratorService now has no
full-history supervisor list calls; underlying query/index and runtime latency verification
are still required, as are broader recovery and mobile acceptance gates.

## Master chat dispatch safeguards (revalidated 2026-10-12)

Manual `dispatch_worker` now checks the shared planner before preparation and inside the
supervisor's synchronous insertion fence. Scope, provider membership, quota freshness/reserve,
provider/global/project worker caps, pending review, task revision and reservations are checked.
Explicit manual dispatch is permitted for paused/Observe masters without changing their mode.
The supervisor gets one attempt, a durable dispatch key and the current task's project context.

Chat intents use the scheduler's persisted reservation and retry budget. A competing same-card
request is refused before preparation. Inserted keyed runs cannot be reclassified as failed by
an acknowledgement error; scheduler reconciliation recovers their assignment. Tests cover
concurrent preparation, task edits, competing global workers, policy/quota/review changes and
winning-run assignment. Simulated three-minute provider preparation verifies that the chat
heartbeat prevents orphan expiry and stops on both successful insertion and preparation failure.
Advancing timers after database closure verifies no callback remains scheduled.

Remaining acceptance work: request-level replay identity, durable task generations, classified
provider/auth waits, runtime crash drills and end-to-end latency/mobile checks. Chat and scheduler
share policy and reservation primitives but still have separate execution flows; a unified guarded
operation remains a maintainability upgrade. These test results do not prove live crash recovery
or measured LAN latency.

Chat superseded-intent accounting now matches scheduled dispatch: a denied insertion releases
only the current keyed claim, refunds that attempt and applies no cooldown. Ordinary provider
preparation failures retain the existing cooldown/budget behavior. Tests verify immediate dispatch
of edited instructions, one refund only, replacement-owner fencing and no refund after run
insertion. This does not add automatic retries or classify authentication/provider failures.

## Process-boundary recovery evidence (2026-10-12)

`processRecovery.test.ts` starts a separate Node process against a temporary file-backed
SQLite database and exits without closing the database at three dispatch boundaries.
Before claim: no reservation exists and a fresh claim is possible. After claim but before
insertion: expiry produces the existing bounded cooldown with one attempt consumed.
After keyed run insertion but before acknowledgement: reopening and repeated reconciliation
recover that exact run, retain its assignment and refuse a competing claim; run count stays one.
All three cases pass. No live database, terminal, master setting or worker input is touched.

This verifies persisted reservation/assignment transitions across process exit, not the full
supervisor/provider lifecycle. Remaining runtime drills need an isolated fake worker executable,
actual supervisor insertion/spawn, competing process ownership and request replay identity.

Process recovery also covers exit after assignment acknowledgement. Child processes now resolve
source modules and the TypeScript loader independently of their working directory and run from
the temporary fixture directory. All four process-boundary cases pass. The acknowledged run
remains assigned through repeated reconciliation and refuses a replacement claim.

Full regression run after the portable recovery harness: `npm test -- --maxWorkers=1`
passes 451 tests across 93 files (123.53 seconds on this host). This independently reaches the
full test gate even though `npm run check` still stops earlier on concurrent UI formatting.
No physical-browser/provider-runtime claims are inferred from the regression result.

Queue preview now renders next-step guidance for typed waiting reasons. Review/live/project
capacity links open that project's Agents tab; global/provider capacity opens all Agents;
quota guidance requests fresh verification and links usage; unavailable CLIs link Settings;
cooldown links the task. Ready decisions add no extra guidance. Four component tests and
thirteen page tests pass. This is navigation/explanation, not automatic recovery or a retry
budget reset; physical mobile verification and classified runtime failures remain open.

Master chat ownership is now reflected in navigation: regular global/project Agents views
filter sessions carrying `orchestratorId`, including their cached initial lists. Orchestrator
chat opens its terminal inline rather than sending the user to Workspace. The inline terminal
retains ordered input, output streaming, resizing and image attachment, with Start/Stop/Restart,
restart feedback and error reporting. Hiding the chat unmounts its stream without stopping it.
Sixteen focused chat/terminal/page tests pass. Project card workers remain project work; master
control sessions are the separate Orchestrator-owned sessions currently identified by the API.
Explicit historical run ownership is not persisted on AgentRun and remains a schema/design gap.

## Workspace and review isolation, 2026-10-12

Created orchestrators now have a compact chooser and one selected workspace, including chat
CLI lifecycle controls and owned dispatched runs with output, stop/retry and review. Activity
counts and events are scoped to selection. Regular Agents lists exclude owned sessions/runs.
Owned worker and pending-review links open the owning Orchestrator workspace and its run
section. Ownership persists across retry and mutable assignment replacement; historical runs
whose assignment was already overwritten cannot be reliably backfilled.

Physical mobile checks, whole-request measurements, full runtime request recovery, and remote
GitHub Project status/reviewer synchronization remain open. The active goal is not complete.

## Manual dispatch replay, 2026-10-12

Chat dispatch now accepts a stable requestId and persists it atomically with the assignment
claim, task revision, argument fingerprint and unique dispatch key. An identical replay
returns the original run status or pending/interrupted guidance; conflicting argument reuse
is rejected. Lookup survives assignment replacement and database reopen. Request insertion
failure rolls back the claim and retry charge. The chat briefing asks the master to supply
and reuse request identities after response loss. Calls without requestId retain the older
reservation behavior for compatibility and do not gain request-level replay protection.

Focused regressions cover concurrent calls, owner isolation, changed arguments, reopen,
completed run recovery, interrupted requests and rollback. Four child-process exit boundary tests also verify replay absence before claim, interrupted
state after claim, and recovery of the inserted run before/after acknowledgement. Actual
supervisor spawning, durable task generations and scheduler-level request identity remain
acceptance work. This closes manual tool replay storage, not the complete runtime crash gate.

Regression validation for manual replay: the full suite passed 467 tests across 98 files
(335.28 seconds). A subsequently added completed-card replay test passed in the 14-test chat
suite. The four process-exit tests passed independently after extension. Typechecking and
lint passed; npm run check stops at formatting in five concurrently edited UI/design files.

## Persisted retry explanations, 2026-10-12

Preview now uses typed retry blocker metadata to distinguish cooldown, exhausted budget,
and an active dispatch/assignment reservation. Previously all three displayed the generic
reservation label and next action even though the stored retry details differed. Live-worker
and review decisions retain precedence, and preview does not modify assignments or dispatch.
The queue can now show the existing cooldown/task and exhausted-budget/run-inspection advice.
Provider authentication classification and explicit bounded recovery remain separate gaps.

Queue preview review and exhausted-budget decisions now include the latest projected run's
identity and persisted owner. Their inspection links open that owner's run section rather
than a regular Agents list that excludes owned work. Unowned runs retain project navigation.
Ownership comes from the existing bounded SQL projection, with no extra history query.

## Inspection hydration, 2026-10-13

Scoped in-flight cards now filter in SQL. Inspection runs use one narrow projection instead
of per-run full hydration, card reads and log stats. Thirty-six focused regressions passed.
The isolated real-route benchmark reduced the 10k-card project inspection median from
317.87 ms to 27.52 ms and all-project inspection from 1,693.83 ms to 386.25 ms in five samples.
See ORCHESTRATOR_BENCHMARK.md for scope and limits. Full visible equivalence is asserted by
the benchmark. The 5.4 MB global response still needs summary/pagination; physical mobile
and complete runtime measurements remain open.

## Pending-work transport pagination, 2026-10-13

Pending inspection now uses a versioned endpoint with validated offset/limit/project scope,
accurate filtered totals and nextOffset. The UI requests ten items and offers Previous/Next;
refresh failures preserve its populated page. Eighteen service/HTTP/UI tests pass. The large
10k-card/100k-history fixture returned 4,562 bytes for a global 20-item page versus 5,409,189
bytes for full inspection. Server still computes the complete situation before slicing;
this bounds transport/rendering, not computation or snapshot consistency across changes.
SQL-level paging, versioned snapshot cursors, mobile browser verification remain open.

## Pending computation follow-up, 2026-10-13

Pending inspection now skips the latest-run index and work-card summaries used only by the
full situation view. It still checks live workers before identifying stalled cards. An
explicit equivalence regression covers project alerts, input requests, reviews and stalled
cards; 22 focused service/route/situation tests and typechecking passed. This is allocation
reduction, not SQL pagination: run/card reads and the complete pending list remain unbounded.
A subsequent five-sample 10k-card/100k-history local benchmark measured pending inspection
at 6.76 ms median for project scope and 148.41 ms for global scope; maximums were 8.95 and
173.44 ms. Responses remained 4,534/4,562 bytes. These are warm-cache in-process measurements,
not LAN/mobile latency or a controlled before/after speedup. The benchmark additionally
asserts that pending totals and the returned first page equal the full situation projection.

## Scoped pending reads, 2026-10-14

Project-filtered pending inspection now narrows card/run SQL projections before loading data.
A filter outside a master's configured scope returns an empty page before supervisor reads;
it never turns an empty intersection into the all-project scope. Pending-only run selection
retains live and all unreviewed runs while omitting latest historical runs used only for card
context. Twenty-five focused tests pass, including scope isolation and history beyond 100k
rows. The isolated benchmark's pending/full-situation equivalence assertions pass. Unfiltered
pending lists still grow with unresolved work; SQL pagination and consistent cursors remain open.

## Automatic refresh correctness gap, 2026-10-14

Current OrchestratorPage refresh reads state, projects, all sessions, in-flight cards and
`api.listAllRuns()` every settled five-second cycle. The latter calls `/agent-runs`, whose
supervisor defaults to the newest 200 rows. The page derives owned run sections, activity
counts and review ownership from this truncated list. Thus an older owned live/unreviewed
run can disappear behind unrelated recent history even though inspection SQL retains it.
This is code evidence, not a reproduced live incident. Pending inspection itself is explicit,
not polled. Replace page refresh with a versioned scoped summary that retains all owned live
and unreviewed runs plus bounded paginated history; test an old owned run beyond 200 unrelated
rows and owner isolation. Keep explicit review actions and populated-view error behavior.
The multi-master route measurements are now recorded in ORCHESTRATOR_BENCHMARK.md; dispatch,
write costs, physical mobile checks and stable snapshot pagination remain outstanding.

## Workspace run feed foundation, 2026-10-14

`GET /orchestrators/:id/runs` now exposes a versioned workspace run feed with a validated
positive `before` identity cursor and bounded history limit (default 20, maximum 100).
Scoped live and unreviewed runs are retained independently of the owned-history cap;
history follows persisted ownership even after project scope changes. Unknown owners return
404 and invalid page arguments are rejected before reads. Query regression retains old
live/review work behind 500 unrelated rows, excludes unrelated history, and verifies that
new insertion does not shift an older history cursor. Eighteen focused query/route/service
tests pass. The page still uses the old global 200-row feed; client integration and selection
race tests remain required. This endpoint currently hydrates returned runs through getRun;
it is a correctness foundation, not the completed efficient summary endpoint.

## Workspace run feed client integration, 2026-10-14

OrchestratorPage now loads its selected master's versioned run feed instead of the global
newest-200 feed, including after actions. Owned history has Previous/Next controls and a
shown-count label. Settled polling retains populated results on errors; owner/cursor identity
and effect cleanup prevent late responses from populating another workspace. Seventeen page
and hook tests pass, covering owner-switch races, cursor navigation, refresh failure and
existing page actions and recovery from a failed history-page request. Physical browser/mobile checks, explicit deep links to historical
runs outside the current page, consolidated summary transport and narrow run hydration
remain acceptance work. The automatic refresh cutoff finding is addressed for actionable
runs by the new server selection, rather than by raising the old global history limit.

## Historical run links, 2026-10-14

Workspace run feeds accept a validated positive `focus` run identity. SQL includes the
requested run only when persisted ownership matches the selected master; focused inclusion
does not change history cursors or paging limits. The client passes its run URL parameter,
fences responses by owner/cursor/focus and displays missing-owned-run feedback. Existing
page/query/route/hook regressions passed (22 tests), followed by ten focused tests including
new focus validation and missing-link feedback. A different owner's historical run cannot
be injected through focus. Physical scroll/keyboard/mobile behavior remains unverified.

## Owned work after scope changes, 2026-10-14

Workspace actionable selection now retains a master's owned live and unreviewed runs even
if their project is removed from its configured scope. They remain available for stop/review
on every history page. Unrelated live/review runs outside scope remain excluded. Accepted or
rejected finished owned work returns to paginated history, avoiding permanent active-feed
retention. Twenty query/route/service tests pass, including scope changes and validation
transitions. This retains visibility and controls; it does not authorize new dispatch outside
the edited scope. Physical UI verification and narrow hydration remain open.

## Batched workspace hydration, 2026-10-14

Workspace run feeds hydrate selected identities through one joined SQL read rather than
one run read plus card read per returned item. Batch conversion preserves requested order,
omits missing rows, deduplicates identities and preserves the existing AgentRun contract.
Fourteen focused supervisor/service tests pass; the isolated real-supervisor fixture asserts
complete equality against individual hydration and exactly one prepared SQL read. Empty
identity lists issue no read. Existing log-size checks and JSON decoding remain per run;
this is SQL-read reduction, not a measured LAN latency improvement or narrow summary payload.

## Scoped chat-agent selector, 2026-10-14

Orchestrator chat now offers configured supported chat providers in an agent selector.
Selecting another provider opens its own chat; server open requests reject providers outside
configuration and default selection no longer falls back to unconfigured providers. Existing
same-provider chats resume when allowed. Seventeen focused chat UI/tool tests pass, including
selector options and scope rejection. Cross-provider conversation transfer is not implemented.

## Full regression rerun under resource pressure, 2026-10-14

The latest full `vitest run --maxWorkers=1` completed with exit 1: 105 files passed,
3 files failed; 532 tests passed and 2 failed, with 3 unhandled worker errors (179.69 seconds).
Failures: Windows CPU-budget affinity fixture produced an invalid child PID; CLI teardown
hit EBUSY removing its fixture; completion matching returned no files. Workers also exited
unexpectedly, including a logged V8 out-of-memory failure. Earlier commands reported paging
file exhaustion and npm-cache ENOSPC. TEMP/TMP were redirected to workspace data/test-tmp;
that puts completion fixtures under this repository's ignored data directory, so inherited
Git ignore behavior is a plausible fixture-placement cause requiring isolated confirmation.
This run does not establish a clean full regression gate or prove all failures environmental.
No live processes were stopped to free resources. Current acceptance still requires a clean
full run, runtime crash recovery, physical mobile checks and the other open audit gates.
Chat switching additionally needs explicit old-session lifecycle handling: selecting another
agent currently creates a separate session and can leave the prior session running.

## Chat switching lifecycle guard, 2026-10-14

Switching providers now rejects replacing a running master chat with a new session (409).
The shared dropdown disables other providers while it is running and explains: Stop current
chat first. Stopped-chat provider selection remains available; the existing terminal Stop
control provides the transition. Twenty-two focused chat UI/server tests pass, with client
and server typechecking and scoped lint. This prevents newly hidden running chats through
this switch flow; historical duplicate sessions and physical mobile behavior remain open.
Cross-provider conversation transfer is not implemented, and the full regression gate is
still failing as recorded above.

## Consolidated acceptance update, 2026-10-14

Recent verified fixes include shrinking-queue navigation, pending scope response isolation,
scoped provider selection, concurrent chat-start rejection, post-discovery scope checks,
running-chat switch guard and immediate successful lifecycle response display. These extend
the existing ownership/cursor and SQL projection work. The latest five pending-inspection
tests and six chat/terminal lifecycle tests passed independently; applicable client types and
scoped lint passed. A subsequent combined Orchestrator regression command with one thread
worker exited 1 on V8 memory allocation failure before reporting test results. It is not a
regression pass or evidence of policy correctness.

Next substantive gates remain scheduler request identity/task generations and actual worker
crash recovery, classified auth/configuration failures, measured dispatch/write costs,
consolidated summary and consistent SQL pending pagination, review evidence/dependencies,
and physical desktop/mobile verification. Recovery must wait for corrected configuration
rather than spending attempts on authentication failures; a future change needs typed worker
failure evidence and integration coverage across dispatch, retry, preview and review.

## Server regression gate, 2026-10-14

`vitest run server/orchestrator --pool=threads --maxWorkers=1` completed successfully:
88 tests across 16 files, 5.01 seconds, using workspace TEMP/TMP. This verifies the current
server planner, assignments, dispatch replay, ownership, query projections, routes and chat
guards as covered by those tests. It replaces the prior grouped-run memory failure as the
latest evidence for this server subset. It does not replace the failed whole-repository
regression or prove actual supervisor-spawn crash recovery, mobile behavior or dispatch costs.

Review evidence already exists in RunCard through RunChangesSummary (changed files and
commits). The page now includes succeeded/failed unvalidated runs in Needs you and excludes
accepted/rejected history; 17 page tests passed in the preceding change. Evidence-linked
acceptance still needs current-worktree/runtime verification rather than assuming stored
change summaries prove a task complete. Keep the full goal active until remaining gates pass.

## Combined Orchestrator regression gate, 2026-10-14

The combined server/UI selection passed 131 tests across 23 files in 17.12 seconds:
`vitest run server/orchestrator server/agents/runBatch.test.ts client/src/components/Orchestrator client/src/components/useOrchestratorRuns.test.tsx client/src/pages/OrchestratorPage.test.tsx --pool=threads --maxWorkers=1`.
TEMP/TMP pointed to workspace test-tmp. This covers the current planner/reservations/replay,
scoped inspection and cursor feed, chat startup/policy/lifecycle, queue review controls and
atomic manual retry guard. No live worker was launched by the manual-retry regression;
its spawn boundary is mocked. The process recovery fixtures persist database rows before
exit rather than launching an actual supervisor worker. Thus actual spawn crash recovery
remains a distinct gate, alongside scheduler request identity/task generations, typed auth
recovery, dispatch/write-cost measurements, consistent SQL pending paging, consolidated
summary transport and physical desktop/mobile verification. Whole-repository validation is
still not established by this subset.

## Integrated bounded workspace feeds, 2026-10-15

The page now polls independent 20-row history, live-worker and review feeds instead of the
legacy unbounded actionable run feed. Each detail feed has its own identity cursor and
navigation. SQL counts include all unresolved scoped work and owned unresolved work retained
after scope changes. A narrow live assignment projection preserves task/project worker
indicators and Retry guards across detail pages, without hydrating commands or log metadata
for the remaining live runs. This identity projection scales with live workers; it is not a
constant-size summary and still needs measured transport evidence at large live occupancy.

Complete counts and live assignments remain visible during cursor changes. Failed initial
loads show their errors instead of the empty-state success message; navigation remains
available on empty/failed pages. Tests cover review totals across pages, stale feed responses,
owner changes and initial review-load failures. Synthetic read-route measurements predating
the live-assignment projection do not establish the latest endpoint payload or mobile latency.

The combined regression command documented above passed 139 tests across 23 files in
52.55 seconds with one thread worker and workspace TEMP/TMP. Client typechecking and targeted
lint passed in the preceding implementation turns. This is a focused regression gate, not
whole-repository or physical-browser verification. Shared Terminal/Workspace/CSS edits remain
outside these commits. The remaining acceptance gates in the table and upgrade plan are still
open, especially actual supervisor spawning under process crashes, scheduler replay/task
generations, classified auth recovery, dispatch/write costs, SQL pending pagination,
consolidated summary transport and current-worktree review evidence.

## SQL pending queue pagination, 2026-10-15

Pending inspection no longer builds all review/stalled-card details before slicing. It counts
those sources in SQL, then hydrates only the requested detail rows. Project alerts and live
session prompts remain an ordered in-memory prefix from runtime state. Review order remains
descending run identity; stalled cards retain updated-time order with an explicit identity
tie-breaker. Live run/session exclusions and the strict 24-hour stalled threshold are tested.
Counts and detail reads execute synchronously on the same connection; offset pages are fresh
views, not a snapshot pinned across separate requests. Queue mutation can move offset entries.

The replacement service test uses real database rows rather than mocking the full situation.
Mixed-source tests compare each page boundary against the existing situation projection.
All 93 server Orchestrator tests across 17 files passed, along with server typechecking and
scoped lint. Isolated Hono pending benchmark command:
`node --import tsx scripts/benchmark-orchestrator-api.mjs --cards=1000,10000 --masters=1 --samples=3 --operations=pending`.
With 100k history, 10k cards: project median 1.11ms/max 1.17ms/4,534 bytes; global median
1.26ms/max 1.28ms/4,562 bytes. Five prepared statements per batch. Three samples establish
neither p95 nor physical mobile/LAN behavior. The benchmark also checks full-situation output
and pending totals/page equivalence. Multi-master dispatch/write costs and the other durable
execution, recovery, review-evidence and physical verification gates remain open.

## Repository gate and scheduler replay recheck, 2026-10-15

Latest `npm run check` passed both TypeScript projects and repository ESLint. It exited 1 at
Prettier in five shared UI files: AgentWorkList.interactions.test.tsx, Dropdown.test.tsx,
project-agents.css, WorkspacePage.tsx and styles.css. Consequently npm test was not reached.
This result does not invalidate the separately passing 93-test server gate, but does not
establish a whole-repository pass. Shared edits were not reformatted or committed here.

Scheduler replay remains incomplete: service execution claims an assignment, then passes its
random dispatch_key to dispatchCard. Assignment retry replaces that key and increments the
attempt count. Recovery reconciles a matching inserted run, while orphan dispatch claims move
to cooldown after 120 seconds. That is attempt-level deduplication, not a durable scheduling
request identity across retries. Any extension must distinguish task revision/generation from
attempt identity, preserve the fresh insertion fence and review policy, and test actual
supervisor process-crash boundaries rather than treating persisted fixture rows as workers.

## Production supervisor recovery evidence, 2026-10-15

processRecovery.test.ts now adds two child-process cases through AgentSupervisor.dispatchCard
with an actual isolated Node fake-worker command. One exits at the production launch-call
boundary after real run insertion/card update; restarting the supervisor launches the queued
run. The other lets that worker finish and exits before assignment acknowledgement; restart
reuses the completed run. Both assert one marker append (one actual worker launch), one run
row, preserved request replay, one charged assignment attempt and a blocked duplicate claim.
The worker only appends to a temporary fixture file, uses no installed AI provider, and the
recovery supervisor is shut down before closing/removing the isolated database directory.
All six process recovery tests passed; server types and scoped lint passed.

This improves the earlier row-seeding-only evidence, but does not prove the full crash matrix.
The pre-launch case substitutes the launch method solely to terminate the dispatching child;
recovery uses the real launch path. Abrupt exit while an actual worker is still running,
launch/attempt-persistence races, scheduler request replay across attempts, task generations,
and pending-review behavior after those races remain unverified. No exactly-once external
side-effect guarantee is claimed for an in-flight worker crash.

## Surviving worker after supervisor crash, 2026-10-15

A new real process fixture waits for a fake worker's PID marker and persisted running status,
then exits its supervisor abruptly. The recovery supervisor does not start another worker for
maxAttempts=1, reports the original run as failed/unvalidated and keeps the assignment reserved.
Request replay points at that same run; one launch marker and one run row remain. The test
confirms the original fixture PID is alive independently of database state, then terminates
only that PID during cleanup. Nine process-recovery/manual-retry tests passed, plus server
TypeScript and scoped lint.

This proves a surviving-orphan limitation, not complete lifecycle recovery. The production
error now explicitly states that the previous worker may still be running and must be inspected
before retry. Automatic scheduler dispatch uses one attempt and remains review-blocked, but
manual retry or generic runs with additional attempts still need durable process ownership,
identity-safe reconciliation and an explicit orphan policy. A stored PID alone is insufficient
because of PID reuse. Do not treat failed status after restart as proof that external work has
stopped, and do not claim exactly-once side effects from the current dispatch key.

The concrete next ownership upgrade is specified in
[One-shot worker ownership and crash recovery](ORCHESTRATOR_RUN_OWNERSHIP.md), based on the
current pipe adapter, authenticated session host, host generation/orphan policy and real
surviving-worker regression. It defines protocol/schema compatibility, unknown-execution
handling, attempt/request identity separation and a real-process acceptance matrix. It is an
implementation plan; none of its proposed host/journal/typed-state behavior is claimed shipped.

## Whole-suite direct test result, 2026-10-15

The confirmed full Vitest process completed exit 1: 112 files passed, three failed; 602 tests
passed and two failed (604 total), 268.44 seconds. It used one thread worker and workspace
TEMP/TMP. Failures were Windows CPU fixture PID parsing, completion file discovery returning
an empty list, and CLI suite cleanup EBUSY. The CPU fixture was changed while that run was
already in progress; its final stack lines reference the changed file, so the final full-run
CPU failure is not evidence against the corrected fixture. A fresh focused run of CPU and
completion fixtures now passes all six tests. Completion fixture now initializes its own Git
repository so ignored workspace TEMP ancestors cannot hide its files. CLI cleanup EBUSY still
needs lifecycle investigation. This is not a whole-suite pass, and formatting failures remain
a separate repository gate. The earlier passing Orchestrator subsets do not close either gate.

## CLI fixture host lifecycle repair, 2026-10-15

The failing CLI teardown called supervisor.shutdown then immediately removed its data folder.
Hosted PTYs deliberately outlive that shutdown, and the detached host retains resources until
its orphan grace expires. The fixture now sets the existing test-only orphan override to one
second, captures its own host rendezvous PID before shutdown, and waits for that specific host
process to disappear before deleting the temporary directory. It restores the environment in
finally and does not terminate production hosts or change session survival defaults. All 18
CLI tests and scoped lint passed with workspace TEMP/TMP. This resolves the observed focused
cleanup failure; a fresh whole-suite run is still required after the three fixture repairs.

## Successful direct full-suite rerun, 2026-10-15

After CPU PID parsing, completion Git isolation and CLI host-exit teardown repairs, the direct
full Vitest run passed 605 tests across 115 files in 184.09 seconds, one thread worker with
workspace TEMP/TMP. This establishes the direct test gate for the pre-outputLog-extraction
state. It does not establish npm run check, whose shared formatting gate remains separate,
or physical mobile/LAN behavior. The subsequent bounded log extraction/host output persistence
passed ten focused log/delivery/launcher tests, server types and scoped lint; that narrower
result does not imply the full suite was rerun after extraction.

## Recovery write cost and startup ordering, 2026-10-16

Unchanged hosted-run polls now perform zero SQLite row writes, verified with
`total_changes()` against a real hosted worker and an unavailable-host case. Output
callbacks still run so log growth remains observable. Committed as d657df6 (PM-64).

A full direct run after recovery integration completed with 611 passing tests and
three installer lifecycle failures (119 files, 168.14 seconds). It exposed an added
asynchronous recovery wait before installer startup cleanup, which could label a
new installation interrupted. Cleanup now runs before the first reconciliation
await. All eleven installer/managed-recovery tests pass after that correction,
with server types and scoped lint. This is not a post-correction full-suite pass.

A further audit found project deletion currently cascades database rows before
worker cleanup. Hosted executions need a pre-delete stop/ownership gate; otherwise
unknown occupancy can disappear without authoritative termination. This remains
open alongside new hosted dispatch routing and automatic host startup.

## Project deletion ownership and regression rerun, 2026-10-16

Project removal now awaits hosted stop acknowledgments before cascading records;
unreachable owners return 409 and preserve tracking. The storage delete includes
an atomic active-owned-run predicate to reject new reservations during the wait.
Sixteen deletion/API/storage tests pass, plus server types, scoped lint and formatting.
Real-host tests cover both confirmed exit and a still-running unreachable worker.

The fresh full Vitest summary reports 616 passing tests across 120 files in 148.92s,
including the installer startup correction and deletion guard. Its PowerShell wrapper
returned exit 1 while redirecting Node warning stderr as NativeCommandError; the
captured log contains no failed tests. Therefore this is a passing Vitest summary,
not a successful shell-command exit or npm run check. The existing shared formatting
gate and physical mobile/LAN validation remain separate. New hosted dispatch and
automatic host startup are still pending; this does not close the full audit.

## Current complete direct regression result, 2026-10-16

The fresh direct Vitest process passed all 631 tests across 125 files in 157.75s,
with exit code 0, one thread worker and workspace TEMP/TMP. This includes opt-in
hosted dispatch, persisted worktree evidence, pre-launch CPU verification, live
Settings CPU refresh and the real host-crash/surviving-worker case. The prior
PowerShell redirection status ambiguity is absent in this direct run. The separate
npm run check formatting gate and physical/cross-platform acceptance still require
independent evidence; the overall Orchestrator objective remains open.

The follow-up npm run check passed both typechecks and repository lint, then stopped
at formatting in the five previously shared UI files plus server/db.ts. The database
warning was entirely CRLF versus LF (no text difference); normalizing its line endings
passed its targeted format check and retained the other agent's schema repair unstaged.
The five shared UI files remain untouched. npm's test stage was not reached; the
separate 631-test direct run above is the current complete test evidence.

## Actionable unknown execution, 2026-10-16

Unknown run details now expose a nonce-fenced manual attestation flow with persisted
provenance, fresh host observation and unchanged task validation. It provides a way
to release an execution slot after independent termination rather than leaving the
user permanently blocked on an unreachable owner. Twenty focused tests and both
typechecks/scoped lint pass. This improves user recovery but does not establish OS
containment or a fresh whole-suite result; see the ownership document for exact limits.

## Measured event-write amplification reduction, 2026-10-16

Complete isolated dispatching ticks exposed per-decision event-blob writes as a
bottleneck. Consecutive wait/review/observe events now persist in bounded batches,
flushing before dispatch and after each master. Tests prove sequential retention/
deduplication equivalence and preserve policy/chat edits across dispatch waits.
The twenty-sample 10k-card/20-master fixture reduced row mutations 10,142 to 182;
observed median tick time changed 8.83s to 3.14s. All 98 Orchestrator tests, server
types and scoped lint pass. Detailed scope and exclusions are in the benchmark
document. Remaining efficiency work includes settled/global scenarios, committed
write durability, policy-read scaling and consolidated summary transport.

## Fresh policy parsing without stale dispatch, 2026-10-16

Per-decision policy lookup now reuses parsing only for an exact match of the latest
persisted JSON value, while still reading it at every decision/commit fence. A
second SQLite connection can pause or narrow scope and the next fence rejects;
public state snapshots remain independently parsed mutable values. All 99
Orchestrator tests and static checks pass. The same twenty-sample largest tick
fixture observed median 3.14s to 0.74s with writes unchanged at 182. Prepared
statement reuse is not a query-count reduction. The benchmark document records
full numbers and exclusions; remaining global/settled/physical and rollout gates
are unchanged.

## Worker recovery links, 2026-10-16

Preview decisions now retain the actual active worker's owner and execution state,
including when a newer finished run exists for the same task (69009c5, PM-64).
Unknown executions link to their owning Orchestrator and explain independent
termination verification before manual resolution. Cooldown decisions with a
persisted worker now offer failed-run inspection while preserving retry timing,
review precedence and attempt limits; dispatch errors without a run retain the
task fallback. The 112-test Orchestrator/component suite, both typechecks and
scoped lint pass. The latest npm run check passed typechecks/repository lint but
stopped at five unrelated shared UI formatting warnings; it did not reach tests.
These focused recovery improvements do not close the broader rollout, typed
runtime-failure, summary-transport or physical/platform acceptance gaps above.

## Visibility-aware workspace refresh, 2026-10-16

Orchestrator overview and history/live/review feeds now opt into visibility-aware
completion-based polling. Hidden tabs schedule no new refreshes; returning clears
the old timer and refreshes immediately without overlap or catch-up bursts. Existing
in-flight requests settle normally and existing response ownership/epoch guards
remain in place. Other poll consumers retain their default behavior. Three lifecycle
cases plus existing poll, run-feed and page tests pass (33 tests), with client types
and scoped lint. This reduces hidden-tab request traffic, not foreground request
count or payload size; consolidated overview transport remains open. No physical
mobile suspension/resumption or LAN latency claim is made by the jsdom checks.

## Consolidated foreground overview, 2026-10-16

The page's state/projects/sessions/in-flight-card refresh now uses one versioned
GET /orchestrators/overview instead of four requests, both on polling and after
actions. The existing serial polling and mutation epochs still fence late responses.
Optional sections return null plus an unavailable key on read failure, preserving
last-known client data and explicit stale warnings; state read failures remain request
failures. No provider calls, launches or database writes are introduced. Existing
paged history/live/review transports are unchanged and still refresh separately.
Service/route and page regressions pass (127 tests), with both typechecks and scoped
lint. This establishes request-count reduction for the overview, not reduced payload
volume, bounded global overview size or measured physical LAN latency. The broader
summary scaling and physical acceptance work remains open.

## Overview session history filtering, 2026-10-16

The overview now returns running ordinary sessions and only the highest-ID chat
session for each Orchestrator, matching the page's existing consumers. Stopped
latest chats remain available for reopening; older chat and stopped ordinary
history remains available through the existing session APIs. Filtering does not
change supervision, delete records or mutate the supervisor's session array.
An unsorted mixed-history regression and existing service/route/page tests pass
(53 tests), with server typecheck and scoped lint. This reduces serialized history,
not the supervisor's underlying list hydration cost or measured LAN latency.
