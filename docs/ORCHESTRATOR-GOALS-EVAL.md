# Orchestrator goals: evaluation against long-running agent harnesses

Evaluated 2026-11-07, after the first live goal runs on the Game Dev orchestrator (PM-433 to
PM-470). The question: does the goal loop drive a goal to a satisfying, verified finish, and what
do established harnesses do that ours does not yet?

## What the references agree on

- **A structured list of requirements, each with a pass state.** Anthropic's long-running harness
  has an initializer write a detailed feature list from the prompt, each item checked off as it
  passes, so the agent neither one-shots the work nor declares it done early; every later session
  picks the highest-priority item not yet passing.
  ([Effective harnesses for long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents))
- **Progress that survives a fresh context.** Each session starts from the progress log, git log
  and the requirement list, and leaves clear artifacts for the next one (same source).
- **Verification against explicit criteria, by someone other than the doer.** A verifier asked
  "is this good?" approves what it is shown; the loop fails when nobody defined what passing
  means.
  ([Multi-agent coordination patterns](https://claude.com/blog/multi-agent-coordination-patterns))
  Claude Code's `/goal` checks its completion condition with a separate model after every turn,
  and a condition must name something checkable
  ([/goal docs](https://code.claude.com/docs/en/goal)).
- **A bounded loop with a fallback.** An iteration or budget limit, then escalate to a person or
  return the best result with caveats (coordination patterns article; `/goal` has no budget, so
  people add a turn or time clause).
- **Precise hand-offs.** A worker given an objective without a target or acceptance conditions
  invents its own
  ([Arize: evaluating agent teams](https://arize.com/?p=33310)).

## How our loop compares

| Practice                         | Ours today                                                                                                     | Gap                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Requirement list with pass state | One prose `doneWhen` per goal; linked cards carry their own notes                                              | No checklist of criteria with pass, evidence and who checked it                            |
| Pick the next unfinished item    | Goal step plans independent cards and staffs them in parallel (PM-461)                                         | None for planning; ordering among ready cards is left to the chat                          |
| Progress across fresh contexts   | Goal progress notes (last 40), card notes, Activity full texts, goal status in every check (PM-461)            | Good; the chat's own context still drifts across long runs                                 |
| Independent verification         | The same chat that did or led the work marks it achieved; the guard only checks linked cards are Done (PM-454) | No separate verification before a goal closes                                              |
| Precise hand-offs                | assign_card and start_session send the card text plus instructions and the worker channel                      | Cards are not required to carry acceptance criteria                                        |
| Bounded loop, fallback           | Quiet goals are checked hourly and notify the owner (PM-459); checks are capped at 4 an hour                   | No budget per goal (checks, time, worker runs) and no "best result with caveats" hand-back |
| Learning from outcomes           | Activity and goal notes record what happened                                                                   | No per-goal outcome measures (time to done, checks, owner interventions, reopenings)       |

## Improvements, in order

1. **Goal acceptance checklist** (PM-471, done 2026-11-07): `doneWhen` becomes a short list of checkable criteria,
   each with a state (open, passing, failing), its evidence and who checked it. The chat drafts it
   with the goal; checks work on the open criteria; "achieved" needs every criterion passing.
2. **Independent verification before closing** (PM-472, done 2026-11-07): before a goal is marked achieved, a fresh
   one-shot worker (or a fresh chat turn with no history) checks each criterion against the repo,
   tests and pull requests and reports pass or fail with evidence; a failure reopens the goal with
   the gap as the next card.
3. **Goal budgets with a hand-back** (PM-473, done 2026-11-07): optional limits per goal (checks, days, worker runs);
   at the limit the chat writes a closing report (what passes, what does not, what it would do
   next) and the goal waits for the owner instead of looping.
4. **Acceptance criteria on every card the goal creates** (PM-474, done 2026-11-07): create_card for a goal requires
   an acceptance check; hand-over prompts lead with it; review compares against it.
5. **Goal outcome measures** (PM-475, done 2026-11-07): per goal, time to done, checks, worker runs, owner
   interventions and reopenings, shown when it closes and summed per orchestrator, to tune the
   loop on evidence rather than impressions.
