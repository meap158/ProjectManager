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
- **Own workers only (PM-417):** `maxWorkers`, `maxWorkersPerProject` and `maxWorkersPerProvider` count only workers the orchestrator owns: runs it dispatched, sessions it started or handed a card to (`start_session`, `assign_card`; ownership ends when the session moves to another card) and sessions enrolled in its supervision. Sessions the owner started by hand never use up the limit. Every live worker still blocks its own card, and the global safety cap of 32 counts all workers. The plan decision and `overview` show own versus other workers. Ownership lives in `server/orchestrator/ownedWorkers.ts`.
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
- `list_sessions`: the CLI sessions in scope, with project, agent, state and linked card.
- `assign_card`: hand a card to a running CLI session in the card's project, the card dialog's
  Send to session (`supervisor.attachCard` with `send`): links it, moves it to In progress and
  types the task in. Only an idle session with no other live card and no undelivered input;
  never the orchestrator's own chat or another project's session. The state is re-read right
  before typing, and the result says the delivery is unconfirmed, so the chat checks with
  `worker_output` instead of resending.
- `start_session`: a new interactive session on a card in its project folder, the card dialog's
  New terminal (`createSession` with the card). It passes the same checks as `dispatch_worker`
  (shared `capacity` and the scheduler's `plan` verdict: worker limits, provider, quota
  reserve, no live worker on the card), plus the per-project session limit. A `requestId`
  replays the same session after a lost response (`orchestrator-session-requests:<id>`), and
  two concurrent calls for one card cannot both start one. Started sessions are ordinary
  sessions: `orchestrator_id` stays reserved for the chat itself.

**Handing work out (PM-399).** `delegateToSessions` on the orchestrator (Orchestrators page,
"Chat may hand cards to CLI sessions"; missing means on) decides how the chat gets work done.
On, its briefing and check prompts tell it to hand ready cards to an idle session in the card's
project, or start one within the limits, and to work directly only when neither fits. Off,
`dispatch_worker`, `assign_card` and `start_session` are refused and the prompts keep the
earlier direct-work rule (PM-181, which this owner request replaced as the default). Watch only
stays a briefing rule: the chat recommends and acts only when the user explicitly asks.

Moves, new cards, dispatches, hand-overs, started sessions and messages appear in Activity
marked "(chat)", and hand-overs and starts are also in the card's agent audit.

**Long sessions (PM-400).** A chat can run for days, be compacted by its CLI or restarted, so
nothing it needs lives only in the conversation:

- Every open rewrites the briefing with the orchestrator's 15 most recent Activity events
  (newest first), so a reopened chat knows what it already handed out and decided.
- The briefing asks it to keep `HANDOVER.md` in its folder current (open threads, hand-overs,
  the user's decisions, what it waits for). The briefing rewrite never touches that file.
- Large artefacts (logs, long output, screenshots, diffs) go to `artifacts/` in its folder and
  are referred to by path. Each open keeps the newest 50 files within 100 MB and removes the
  rest (`pruneArtifacts`): the folder holds only what the chat wrote there.
- `get_card` lists a card's images and `read_image` returns one as native MCP image content
  (the board bridge passes a `mcpContent` result through), so screenshots are never pasted
  as text.
- The board stays the durable record: evidence goes on cards. Codex conversations are slimmed
  of old screenshots on relaunch as for any session (`server/agents/codexImages.ts`).

Routes: `POST /api/orchestrators/:id/chat` opens it (reusing its session, restarting it if
stopped) and `POST /api/orchestrators/:id/check` with `{ focus: all | todo | in_progress |
review }` asks it for a one-time check on pending work: In progress (check progress, move
finished work to Review with evidence, nudge idle workers, note what blocks stalled cards),
Review (what is ready to accept), To do (start workers for ready tasks within the limits, split
large ones, note questions) and Needs attention. Watch-only orchestrators recommend instead of
starting workers. The check is refused (409) while the chat is working or asking you something.

On the Orchestrators page each orchestrator has an "Ask this orchestrator" panel (Start/Open
chat opens it in Agents; "Ask it to check" buttons, plus a "Project alerts" row with "All alerts" and per-kind chips that run the Needs attention check
for one alert kind: `POST /orchestrators/:id/check` with `focus: "attention"` and `attentionKinds`), and orchestrators, their sections and
Activity collapse with a chevron (remembered in the browser, `pm.orchestrator.collapsed`).

## Next integration work

1. Persistent instance/assignment/event storage and validated API.
2. Serialized tick executor around the scheduler with fresh pre-dispatch checks.
3. Provider suitability, per-project preferences and safe existing-worker handoff.
4. Stall/recovery/review coordination and master-agent tools.
5. Orchestrator page/navigation and complete verification.
