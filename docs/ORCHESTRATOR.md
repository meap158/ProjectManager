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

## Next integration work

1. Persistent instance/assignment/event storage and validated API.
2. Serialized tick executor around the scheduler with fresh pre-dispatch checks.
3. Provider suitability, per-project preferences and safe existing-worker handoff.
4. Stall/recovery/review coordination and master-agent tools.
5. Orchestrator page/navigation and complete verification.
