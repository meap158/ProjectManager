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
- **Runs get the Settings permission level (PM-419):** a run an orchestrator starts (the background loop or the chat's `dispatch_worker`) uses the level Settings > Agent permissions gives that CLI, as an interactive session would (`runLevel` in `server/agents/permissions.ts`). Claude's default, auto mode, becomes `--permission-mode auto`: commands its classifier judges safe run, risky ones are blocked. Read, edit and full map onto the run autonomy of the same name, and "CLI default" keeps edit. The mode is stored on the run (`permission_mode`) and shown on its card as "auto mode". Every Claude run, manual or not, also gets `--allowedTools mcp__projectmanager`, so its card-scoped board tools work with nobody there to approve them. Before this, runs were edit-only: every shell command and board tool was denied, so they could only report.
- **Only its own In progress work is recovered (PM-420):** the background loop picks an In progress card with no live worker back up only when this orchestrator worked on it before (a run it dispatched, a session it started or handed the card to, or one it supervises: `ownedCardIds` in `ownedWorkers.ts`). Any other In progress card waits as `foreign_work` ("In progress under work this orchestrator did not start; its chat decides"), because a session not linked to the card is often still on it. The chat can still start a worker on such a card when it judges that right. To do cards are unchanged.
- **No new workers on a full machine (PM-424):** before starting a worker (background dispatch, the chat's `assign_card` and `dispatch_worker`, and the plan preview) the planner checks free space on every drive holding a project in scope and the temp folder (builds and tests write there), and free memory. Under 2 GB of disk or 1 GB of memory the card waits as `low_resources` with the drive and amounts in the reason. Running work is left alone, and work starts again once there is room. A run once failed `npm run check` with ENOSPC on a full C:. Code: `server/orchestrator/resources.ts` (thresholds are constants there, read at most every 15 seconds).
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
  types the task in. Only an idle session with no other live card and no undelivered input (a
  session still linked to a card in Review or Done counts as free: the link moves and the result
  names the card it left, PM-437);
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

**Checking on its own (PM-418).** The opt-in setting `autoCheck` ("Check on its own") makes an
enabled, autonomous orchestrator ask its own chat for this same check (`chat.check`, so the same
409 guards) when something changed in scope: a session it owns or supervises stopped working, a
card moved to Review, or a provider's quota came back above the reserve (only while a To do card
waits or the board changed since the last check, so a 5-hour reset alone asks nothing). A slow fallback fires
after 30 minutes when any card is pending and the board (To do, In progress and Review cards
in scope) changed since the last automatic check, so work that only waits on you is not
checked again and again. Bounds: at most 4 automatic checks an hour, 5 minutes
apart; never while the chat is working, asking you, or has queued input; a stopped or unopened
chat is never started. Paused, watch-only or off forgets the baseline, so Pause stops it at
once and turning it on starts from a fresh look. Each check is recorded in Activity as
`auto-check` with its trigger. State lives in `orchestrator-auto-check:<id>` and only advances
when a check is sent, so a deferred trigger stays pending and a restart neither repeats nor
loses one. Code: `server/orchestrator/autoCheck.ts`.

**Drafting the next cards (PM-426).** The opt-in setting `planFromGoals` ("Draft the next cards
when a project has nothing to do") works with Check on its own. A project in scope is idle when it
has no To do and no In progress card. The automatic check fingerprints each idle project (its
`ROADMAP.md` plus every card's id, status and update time) and asks the chat for a `plan` check
when a fingerprint differs from the one it had at the last planning check. With other triggers
pending, the plan step joins the full check instead. The chat reads the roadmap's current phase,
any handover or notes file and the Backlog, lists every card first so it never duplicates one,
and moves up to 3 ready Backlog cards to To do or creates up to 3 small cards with acceptance
criteria and their source in the notes. A missing or Draft roadmap gives Backlog cards only,
because the scheduler starts workers on To do cards by itself. Work only the owner can do goes
in its report, not on the board. Bounds: the hourly bounds above, at most 6 planning checks a day,
and a roadmap with nothing left is not asked about again until it or the board changes. The
fingerprints live in the same `orchestrator-auto-check:<id>` state. `POST /check` accepts
`focus: "plan"` for a check on demand.

**Accepting finished work (PM-427).** The opt-in setting `acceptReviews` ("Accept finished work
itself") changes the Review step of every check: the chat verifies each Review card itself (its
notes, the commits and diff, the project's quick checks) instead of reporting what is ready for
the owner. `update_card` then carries the verdict to the card's finished runs: moving a card to
Done needs an evidence note and accepts its succeeded, unvalidated runs (`validateRun`, as the
owner's Accept does, so they leave Needs attention), and sending a Review card back to To do needs
a note saying what is missing and rejects them. Activity records each as `accepted` or `rejected`
with the run ids. Work that needs the owner's judgment (visual or product decisions, real devices,
accounts, payments) stays in Review with a note. Off, moves never touch runs and the owner still
accepts or rejects them.

**Git on its own (PM-428).** The opt-in setting `gitAutonomy` ("Git on its own") lets the chat push,
open and merge pull requests and manage branches without asking. It does so only through the `git`
tool (`server/orchestrator/gitTool.ts`), which runs `git` or `gh` with an argument array in a
project in scope, as that project's own commit author and GitHub account (`projectGitEnv`, the
environment its agent sessions get), with prompts disabled, a 3-minute timeout and tokens redacted
from the output. The briefing tells the chat never to push from its shell, which may use the wrong
account. Whatever the setting, the tool refuses force pushes (`--force*`, `-f`, `+refspec`,
`--mirror`), pushes to a URL instead of a configured remote, deleting `main`, `master`, `trunk` or
`develop`, discarding uncommitted work (`reset --hard`, file checkout or restore, forced switch or
rm, `stash drop`), skipped hooks, options that run another program, global options and config,
interactive rebases, deleting tags, changing remotes, gh's `--delete-branch` and `--admin`, and gh
commands that delete, transfer, archive or rename. Only `pr`, `issue`, `run`, `workflow`, `repo`
(read), `release`, `label` and `status` are offered from gh. Commands that change something are
recorded in Activity as `git`. With the setting on, the briefing and the Needs attention step tell
the chat to push verified unpushed work and merge ready pull requests; off, they keep the "never
push or merge without authorization" rule and the tool refuses.

**Serve first (PM-430).** `priorityProjectIds` ("Serve first" on the edit form) names projects whose
work goes before everyone else's. The planner splits the scoped projects into two groups, priority
and the rest, and takes the priority group in full before the other gets a turn; within each group
it keeps the least-recently-served rotation, and the worker limits (per project, per provider,
total) are unchanged, so a priority project at its per-project limit lets the next project's card
through. The briefing marks those projects "(priority)" with a rule to hand out, work on, review and
plan their cards first, and `overview` marks them with `priority: true` and lists their To do cards
first. Empty means fair rotation only.

**Worker messages and goals (PM-432, PM-433).** Sessions an orchestrator owns can write to it
(`message_orchestrator`: question, handoff, blocked, status), and its chat answers with
`reply_worker`, queues messages for busy sessions and reads answers with `worker_reply`. Goals are
objectives the chat pursues until a checkable condition holds, brought back by the automatic check
and shown in a Goals panel under the chat. Like an epic, a goal names its projects (none means all
of the orchestrator's) and links the cards that deliver it (PM-448): `set_goal` takes `projects`
and `cards` and also links card keys named in its own text, `create_card` takes `goalId`,
`update_goal` takes `linkCards`/`unlinkCards`, and the briefs show each card's status and
"N of M" done. Every link is checked against the orchestrator's projects. Details, bounds and the Grok Bot comparison are in
[ORCHESTRATOR-SESSION-SUPERVISION.md](ORCHESTRATOR-SESSION-SUPERVISION.md).

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
