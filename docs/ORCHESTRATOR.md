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

## Chatting with an orchestrator (its own CLI)

Each orchestrator has a chat: a normal agent session (Claude Code, Codex, OpenCode or Antigravity,
the first of its providers that is installed) whose `agent_sessions.orchestrator_id` names the
orchestrator (`server/orchestrator/chat.ts`). It runs in its own folder, `data/orchestrators/<id>/`,
never a project folder. Every open rewrites `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` there with
the orchestrator's briefing: its settings, each project in scope (path, git state, board counts), its
tools and its rules (read projects freely, change them only through workers; never push, merge
or delete branches; every card move gets a note).

Its `projectmanager` MCP server gives it the orchestrator's tools instead of the single-card ones (same
transport and capability token, `registerBoardMcp` asks the `OrchestratorToolHost`). All of them
are limited to the orchestrator's projects at call time:

- `overview`: settings, capacity, projects, To do cards, Needs attention, Being worked on.
- `list_cards`, `get_card`: the board; a card's live workers, recent runs and agent activity.
- `update_card`: move a card and/or append an "Orchestrator note" (audited).
- `create_card`: in a project in scope.
- `dispatch_worker`: a one-time run on a card, with the card's situation context plus the
  chat's instructions. Refused at the orchestrator's total or per-project worker limit, on a card that
  already has a live worker, or with a provider the orchestrator doesn't use.
- `worker_output`: a worker session's screen or a run's output tail.
- `message_worker`: a message to a worker session, only while it is idle (never while it works
  or is asking the user something).

Moves, new cards, dispatches and messages appear in Activity marked "(chat)".

Routes: `POST /api/orchestrators/:id/chat` opens it (reusing its session, restarting it if
stopped) and `POST /api/orchestrators/:id/check` with `{ focus: all | todo | in_progress |
review }` asks it for a one-time check on pending work: In progress (check progress, move
finished work to Review with evidence, nudge idle workers, note what blocks stalled cards),
Review (what is ready to accept), To do (start workers for ready tasks within the limits, split
large ones, note questions) and Needs attention. Watch-only orchestrators recommend instead of
starting workers. The check is refused (409) while the chat is working or asking you something.

On the Orchestrators page each orchestrator has an "Ask this orchestrator" panel (Start/Open
chat opens it in Agents; "Ask it to check" buttons), and orchestrators, their sections and
Activity collapse with a chevron (remembered in the browser, `pm.orchestrator.collapsed`).

## Next integration work

1. Persistent instance/assignment/event storage and validated API.
2. Serialized tick executor around the scheduler with fresh pre-dispatch checks.
3. Provider suitability, per-project preferences and safe existing-worker handoff.
4. Stall/recovery/review coordination and master-agent tools.
5. Orchestrator page/navigation and complete verification.
