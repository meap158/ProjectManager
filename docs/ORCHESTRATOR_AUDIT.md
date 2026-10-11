# Orchestrator audit and upgrade plan

Implementation status, revalidated 2026-10-11:

| Area                     | Evidence now                                                                                                                                                           | Remaining acceptance work                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Durable execution        | Persisted dispatch identity, direct keyed reconciliation, orphan cooldown, lease epochs/heartbeat and synchronous pre-insertion policy fence; service/assignment tests | Task revision identity and broader crash/failure matrix                                |
| Controls and convenience | Scoped Check now, read-only paged preview, quick pending-work actions with retained results, explicit Pause/Observe/Autonomous modes; 11 page tests                    | Physical mobile/browser verification and actionable unified Home situation UI          |
| Efficiency               | Single-flight checks, settled polling/stale response guard, idle snapshot reuse, transition dedup, project round-robin, bounded preview responses                      | Indexed latest-run projections, compact/versioned summary, SQL/quota/LAN benchmarks    |
| Follow-through           | Persisted retry budget, cooldown, review reservation and episode-based attention dedup                                                                                 | Classified recovery, task generations, evidence-linked review and bounded worker reuse |
| Evaluation               | Pure planner baseline and full repository checks (370 tests at prior checkpoint)                                                                                       | End-to-end completion/latency/token metrics and runtime failure drills                 |

Preview enrichment now happens after pagination. Retry metadata is selected only for page
card IDs using the assignment primary key, with no query for an empty page. This reduces
metadata allocations and full-table retry reads; full planning/history costs remain unchanged.

Completion is not yet proven for the full upgrade: task generations, broader crash testing,
runtime/mobile verification and end-to-end efficiency benchmarks remain open. Historical
findings below describe the initial audit, not the current implemented state.

Audited against the current worktree on 2026-10-11. No masters were enabled and no
worker input was sent. Findings below derive from code; they are not live incident claims.

## Current implementation

The orchestrator is a deterministic board scheduler with persisted named policies,
project scope, provider preferences, concurrency limits, fresh-quota checks, review
exclusion, serialized ticks, SQLite lease/claims and optional Dashboard follow-up.
The UI supports Start/Pause, editing, Check now, board summaries, live workers and
filtered decision history. Paused masters avoid expensive inspections; recurring ticks
wait for completion. These foundations should remain.

## Prioritized findings

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
