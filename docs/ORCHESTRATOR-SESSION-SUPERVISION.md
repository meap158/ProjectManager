# Scoped session supervision (PM-405)

## Research, 2026-11-02

The owner asked for Grok Bot-style coordination before implementation. Primary references:

- [Grok Bot 101](https://x.ai/bot/guides/grok-bot-101): specialist agents can message and trigger one another; an outer coordinator delegates implementation to a coding harness.
- [Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration): asynchronous handoffs wake recipients, with one owner at each stage to avoid duplicate work. Visible handoffs and progress keep the owner informed.
- [Designing Grok Bot](https://x.ai/news/designing-grok-bot): persistent identity and presence distinguish working, waiting, blocked and done states.

These describe a coordination model, not an implementation contract or permission to message external bots. ProjectManager keeps coordination local through its existing scoped MCP tools and terminal supervisor.

## Existing mechanisms and gaps

`OrchestratorChat` already lists scoped sessions, reads worker output, assigns cards, starts workers and messages idle sessions. PM-399 already enforces limits for new sessions. The leased scheduler prevents competing dispatch loops. Codex quota rotation and reset continuation, plus Claude native continuation, have separate ownership and must remain intact.

Missing capabilities: a structured eligibility check, an explicit wake action for stopped sessions, persisted ownership of sessions under automatic supervision, and repeated continuation of unfinished card work without requiring another owner message.

## Implementation contract

- Add an off-by-default orchestrator setting for automatic session continuation. Only enabled autonomous orchestrators with delegation enabled may act automatically.
- Persist explicit session enrollment with one orchestrator owner and the assigned card. Delegation tools enroll newly assigned/started sessions when the setting is on; existing sessions require explicit enrollment.
- Expose check, enroll/disable, continue and wake tools within the same project/provider scope. Check returns names, card identity, progress evidence, eligibility and exact wait reasons.
- Automatic continuation requires a running idle AI CLI, an in-progress assigned card, no user question, no queued input, a readable empty prompt, fresh quota above reserve and no active usage-limit/native continuation. Revalidate immediately before sending.
- Stopped sessions are never automatically resurrected. An explicit wake tool reuses the saved session, rechecks quota/capacity and returns without blindly sending a second prompt.
- Persist the screen/progress fingerprint before delivery, with a cooldown. The same observed state cannot trigger another send, even after restart or lost acknowledgement. Uncertain delivery is checked rather than blindly retried.
- Run supervision under the existing scheduler lease, with bounded work per tick. Pausing, scope changes, disabled delegation, card review/done and ownership changes stop automatic sends.
- Reuse existing assignment/progress tools and decision history. No new peer messaging network, approval bypass, credential rotation mechanism or shell input path.

## Acceptance evidence

Tests must cover project/provider isolation, competing owners, off/paused/watch-only mode, healthy/exhausted/stale/reset-due quota, working/input/question/queued/draft guards, stopped wake, duplicate sends across restarts, card completion and progress changes. UI must expose the opt-in using the existing settings layout. No live worker receives input during validation.

## Controls and validation

In Orchestrators, edit a master and select **Auto-continue enrolled sessions while quota permits**.
Start the master to authorize automatic checks. Existing workers can be enrolled or released through
`supervise_session`; `check_session` explains readiness, and `worker_output` provides further context.
Disable the setting or pause the master to stop automatic continuation. Native provider quota waits
remain in control; a reset timestamp alone never proves quota is available. Unknown quota blocks
supervision even when the separate unknown-quota worker-start option is selected.

Where quota comes from: Codex reads the session's own saved account, Claude its live login, and
Grok (PM-413) the live login's Grok billing reading, refreshed when a check finds it missing or
stale. Grok sessions keep the login they started with until restarted; automatic Grok rotation
restarts them, a manual switch does not. Antigravity (PM-415) uses the live login's quota reading
from the Antigravity accounts panel, read at most once a minute and refreshed when it is not
fresh; its idle prompt is a bare `>` that the shared check reads, and its "Individual quota
reached" message counts as a provider wait. OpenCode has no account reading yet, so its sessions
stay blocked as unknown quota. Grok draws its input inside a box (`│ ❯ … │`), so its empty-prompt
check is its own (`emptyGrokPrompt`), checked against real rendered Grok screens.

The existing scheduler checks every 30 seconds, inspects at most 50 enrolled sessions per master
in rotating order, and requires at least 60 seconds between sends. Delivery fingerprints survive
restarts, repeated enrollment and transfer from a released owner. Explicit wakes count in-flight
starts against capacity. Enrollment left by a deleted master can be claimed by another scoped master.

Validation: focused orchestrator and UI tests, client/server typecheck, ESLint, Prettier, prose audit
and production build. A production launcher with isolated data saved and reloaded the opt-in setting.
Actual settings markup fits 320px, 390px and 1280px captures. Broad test runs also exposed a pre-existing
Files iframe dark-scrollbar assertion; this unrelated failure is not claimed as passing. Live CLI
continuation and credential switching were not exercised, and no real worker received test input.

## Two-way messages and goals (PM-432, PM-433, 2026-11-06)

The owner asked for the Grok Bot features between the orchestrator and its sessions: asking for
progress, handing out tasks, answers that reach the asker, and working toward an objective until
it is reached.

| Grok Bot feature                                                               | Here                                                                                                                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assign a task to a specialist                                                  | Already there: `assign_card`, `start_session`, `dispatch_worker`                                                                                                    |
| Ask for progress                                                               | Already there: `message_worker` to an idle session, `worker_output`; new: `worker_reply` reads its answer as text from the CLI's transcript                         |
| Message a busy agent                                                           | New: `message_worker` with `queue: true` waits and is typed in once the session is idle                                                                             |
| Asynchronous handoff that wakes the recipient                                  | New: sessions call the board tool `message_orchestrator` (question, handoff, blocked, status); with "Check on its own" on, an idle open chat is handed the messages |
| Answers route back to the asker                                                | New: `reply_worker` queues the answer for that session, delivered when it is idle                                                                                   |
| One owner per stage                                                            | Kept: a session reaches only the orchestrator that owns it (handed it its card or supervises it); routing between sessions goes through cards                       |
| Visible handoffs                                                               | Every message, delivery and drop is recorded in the orchestrator's Activity                                                                                         |
| Presence                                                                       | Already there: idle, running and input in `list_sessions`                                                                                                           |
| Routines that run until the job is done                                        | New: goals (below)                                                                                                                                                  |
| Group chats, voice, drafts, shared logins, a separate review agent, "Stop now" | Not done: not part of this app's local model; interrupting a session mid-edit is left to the owner                                                                  |

**Messages (PM-432).** `server/orchestrator/workerMessages.ts` keeps them per orchestrator in
settings (`orchestrator-messages:<id>`, last 300), so a restart neither loses nor repeats one. The
sender of `message_orchestrator` is the session its board grant belongs to, never an argument; it
is refused when no enabled orchestrator owns the session or that orchestrator is Watch only. Loop
guards: a session may send 6 an hour, only a question asks for a reply, an orchestrator may queue 3
undelivered messages per session, and the chat is woken at most 6 times an hour, 2 minutes apart.
`WorkerMessenger` (a 15-second tick) types a waiting reply into its session only when that session
is running, idle and has no queued input, never while it is asking the owner something; a message
for a session that ended is dropped and recorded. Worker messages wake the chat only when the
orchestrator is enabled, not Watch only, has "Check on its own" on, and its chat is open and idle;
otherwise they wait in `overview`'s `workerMessages` (reading them there marks them delivered). The
prompt says they are reports, not the owner's authority. Sessions the chat hands a card to are told
about the tool in their task text (`WORKER_CHANNEL`).

**Goals (PM-433).** `server/orchestrator/goals.ts` stores goals per orchestrator
(`orchestrator-goals:<id>`): title, objective, a checkable `doneWhen`, status (active, paused,
blocked, achieved, dropped) and progress notes. The chat records one with `set_goal` when the owner
asks it to pursue an objective until done, reports with `update_goal`, and reads them with
`list_goals` or `overview`. The owner can add, pause, resume, mark achieved or drop goals in the
Goals panel under each orchestrator's chat (`GET/POST /orchestrators/:id/goals`,
`PATCH /orchestrators/:id/goals/:goalId`). With "Check on its own" on, the automatic check brings
an active goal back every 15 minutes (within its hourly bounds) with the `goal` focus, and any other
automatic check carries the goal step too. The step tells the chat to compare the state with
`doneWhen`, plan cards, and do each the way it needs: an idle session in the project, a new session
within the limits, a one-time run, or itself. Each check that carries the step counts toward a quiet
limit, reset by `update_goal`, a linked card changing or a session working on one (PM-456). After
four checks without progress the goal stays active (the owner's decision, PM-459: goals are never
blocked automatically), gets one note and a "Goal not moving" notification, and is checked hourly
instead of every 15 minutes until something moves, so a stuck loop spends little quota. At most 5 goals are active at once. Watch only orchestrators have none.

**Goal notifications (PM-436).** `GET /orchestrators/goals/recent` lists goals across orchestrators that
reached achieved or blocked in the last day, with the latest note. With the Inbox desktop
notifications on, the app reads it every 30 seconds and notifies each change once ("Goal achieved:"
or "Goal blocked:" with the orchestrator and note), so a goal that ran on its own reaches the owner
when it ends or needs them.

**Goals nothing continues (PM-437).** The same list carries an active goal with status `stuck` when
nothing will bring the chat back to it (the orchestrator is paused, "Check on its own" is off, or
its chat is closed) and it has not moved for two nudge intervals (30 minutes). It notifies as
"Goal not moving:" with the reason. The Goals panel and `set_goal` also say when the orchestrator is
paused. The first live goal (Game Dev, 2026-11-05) showed the need: the orchestrator was never
started, so no automatic check ran, and the goal sat active with its last note at 22:03 while the
owner drove every step by hand until the chat closed.
