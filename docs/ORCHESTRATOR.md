# Master orchestrator

Requested outcome: a separate orchestrator overseeing all projects or selected projects, checking Board progress, pushing work toward completion, and creating or reusing appropriate agent workers while quota remains.

Implementation in progress. The scheduler is implemented in server/orchestrator/planner.ts.
The service persists instance settings/events and performs serialized dispatch with fresh
capacity checks. Production ticks every 30 seconds, but only explicitly enabled instances run.
No production instances have been enabled. Recovery, master tools and UI remain incomplete.

## Required end state

- Separate Orchestrator UI and durable instances with name, enabled/paused state, all-project or selected-project scope, provider preference and per-project overrides.
- Periodic board and worker inspection with an explicit audit trail of decisions and outcomes.
- Capacity-aware dispatch using installed providers, fresh quota reports, quota reserve and global/project/provider concurrency bounds. Unknown quota remains visibly unknown with an explicit policy.
- Reuse idle card-linked workers when safe; dispatch new board-linked workers when needed; never send into a worker awaiting user input or actively executing.
- Detect stalled work, apply bounded nudges/recovery and cooldowns, and avoid duplicate assignments across overlapping orchestrators, concurrent ticks and restarts.
- Scope-constrained board access for the master agent: progress inspection, task assignment, decomposition, blocking and follow-up. Worker prompts include card context and verifiable completion criteria.
- Respect provider permission settings; review completed changes before accepting completion. Do not equate process exit with task completion.
- Persist assignments, tick lease, retry budget and events so reboot does not cause duplicate dispatch. Show quota exhaustion and next reset as waiting states.
- Responsive scope/provider filters, board progress summary, live workers, event log, Start/Pause/Run now, and links to cards and agent terminals.
- Tests for quota exhaustion/staleness, scope isolation, concurrency, duplicate prevention, recovery, pause, reboot, review and UI behavior; full project checks and browser verification.

## What an orchestrator sees of Home (situation)

`GET /api/orchestrators/situation` (all projects) and `GET /api/orchestrators/:id/situation`
(one master's projects) return what the Home dashboard shows, with the identity to trace each
item back (`server/orchestrator/situation.ts`, types in `shared/orchestrator.ts`):

- **needsAttention**: Home's project alerts (folder missing, scan failed, stale, uncommitted,
  unpushed; dismissed kinds left out), sessions asking for input (with what is on screen),
  finished runs awaiting review, and stalled cards (in progress, no live worker, unchanged for
  24 h). Each item carries its project and, where it applies, card, session and run ids.
- **beingWorkedOn**: every In progress / Review card with its live sessions and runs (and their
  state), its latest run's outcome, what last moved it (commit, PR or branch) and the attention
  kinds that concern it.

When a master dispatches a card, the worker's prompt gets that card's slice of the situation
(`cardContext`): board status, live workers, latest run, what moved it, card-level attention and
its project's alerts, so it can trace back and coordinate instead of starting blind.

## Next integration work

1. Persistent instance/assignment/event storage and validated API.
2. Serialized tick executor around the scheduler with fresh pre-dispatch checks.
3. Provider suitability, per-project preferences and safe existing-worker handoff.
4. Stall/recovery/review coordination and master-agent tools.
5. Orchestrator page/navigation and complete verification.
