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

The existing scheduler checks every 30 seconds, inspects at most 50 enrolled sessions per master
in rotating order, and requires at least 60 seconds between sends. Delivery fingerprints survive
restarts, repeated enrollment and transfer from a released owner. Explicit wakes count in-flight
starts against capacity. Enrollment left by a deleted master can be claimed by another scoped master.

Validation: focused orchestrator and UI tests, client/server typecheck, ESLint, Prettier, prose audit
and production build. A production launcher with isolated data saved and reloaded the opt-in setting.
Actual settings markup fits 320px, 390px and 1280px captures. Broad test runs also exposed a pre-existing
Files iframe dark-scrollbar assertion; this unrelated failure is not claimed as passing. Live CLI
continuation and credential switching were not exercised, and no real worker received test input.
