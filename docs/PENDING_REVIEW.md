# Pending ProjectManager review — updated 2026-10-23

Checked the live project board and AGENT_HANDOVER.md. Review status is not evidence of unfinished
implementation; many cards await owner/device acceptance. Do not relaunch workers for those cards.

Latest account follow-up: PM-243 is committed in 1478806. The selected Codex credentials now
become the default login and all Codex CLIs use the default home, retaining conversation history.
The handover explicitly leaves a live switch of running CLIs unverified; that remains an owner
acceptance step. Do not rely on earlier notes describing every CLI using its saved profile home.

## Verification follow-up, 2026-10-23

Client/server typechecks and whole-repository lint passed. Removed an obsolete local staging
helper that was incorrectly included by lint. Formatting found only cfAccess.test.ts; corrected
in e35018c. The full single-worker suite completed with 815 passed / 7 failed, 149 files:
six agent lifecycle tests exceeded deadlines and one hosted-launcher completion poll expired.
Isolated reruns with a 30-second test deadline passed all 23 agent tests and all three launcher
tests. This is not a green full-suite result. Process tests remain sensitive to machine load;
concurrent edits also changed agent source during the run, so source line references shifted.
Do not treat passing reruns as evidence of real-phone or live-login acceptance.

Subsequent process-test rerun hit native V8 `Fatal process out of memory: Zone` errors and
an unexpectedly exited worker; this is no longer just a timeout observation. At inspection,
Windows reported about 1.85 GiB physical and 2.21 GiB virtual memory available (31.9 GiB RAM,
55.6 GiB total virtual). No unrelated process was stopped. Removed the proposed broad agent
test timeout increase; it cannot resolve allocation failure. Hosted launcher completion alone
gets a bounded 10s poll instead of the 1s default, retaining the completion assertions.

| Card                                                   | Current finding                                                                                                                                                                     | Next step                                                                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| PM-242                                                 | Implemented in c955bb2: desktop tag/status/control alignment; no 222px action minimum. 18 interaction tests and build passed.                                                       | Owner desktop/mobile visual acceptance.                                                                                     |
| PM-165                                                 | Batch choice prompts were captured only on dialog opening. Added a live re-read before each detected key/line response; changed/unreadable prompts receive no input. 14 tests pass. | Owner acceptance of representative live CLI menus; detection remains heuristic and read/send is not atomic.                 |
| PM-240                                                 | Opt-in remote access implemented; handover explicitly lacks real Cloudflare tunnel/Access validation.                                                                               | Owner setup on the Owner desk (DT-005), then real remote acceptance. Do not enable public access as part of a review sweep. |
| PM-176, PM-177, PM-163, PM-171, PM-190, PM-200         | LAN performance/mobile sizing/chat work has automated evidence, but actual phone acceptance remains open.                                                                           | Real phone, narrow portrait and landscape; LAN typing and first-load measurements.                                          |
| PM-173, PM-169, PM-168, PM-196, PM-197, PM-198, PM-188 | Account drawer/usage/switching work implemented. Handover still limits claims about real quota-bearing cross-account conversation continuity.                                       | Owner login/quota and visual acceptance without disrupting active sessions.                                                 |
| PM-174, PM-172, PM-179                                 | Chat progress and direct-work prompts implemented. Board review notes dispatch_worker remains callable despite direct-work instructions.                                            | Decide whether explicit worker dispatch should remain available; do not call it during review.                              |
| PM-153                                                 | Character Library filter belongs to TrendRelay, as card history confirms.                                                                                                           | Re-home/review with TrendRelay Library cards.                                                                               |
| PM-211, PM-212                                         | Backlog research, not active fixes.                                                                                                                                                 | Separate scoped research; provider evaluation needs configured accounts and a real benchmark task.                          |
| PM-229–PM-232                                          | Parked project ideas. PM-232 explicitly deferred until existing ConnectJobs repository is cloned.                                                                                   | Preserve deferred status; do not create replacement projects.                                                               |

The repeated server-exit root cause is still unconfirmed. Recovery and durable diagnostics are
implemented in af388a2. The current diagnostic tail contained HMR/scan activity, with no fatal
stack file when checked. Absence of another crash is not proof the initiating defect is fixed.

Native V8 heap/allocation fatal messages now also trigger bounded launcher recovery when
the development watcher remains alive: native failures bypass the application's exception
monitor. Seven recovery tests pass, including split native fatal messages and an actual
disposable launcher restart. This requires restarting the launcher to load the change;
no live session was restarted, and no captured live fatal stack establishes the original cause.

Follow-up: scanner periodic refresh and commit/PR watchers now contain failures at the job
boundary, log them and continue on the next poll. Regression tests inject a database read
failure and verify the busy flag is released and polling resumes. This removes an uncaught
timer/unhandled-promise path; it has not been linked to a captured production crash stack.

Commit fingerprint acknowledgement also now happens only after card-reference processing
succeeds. A transient processing failure retries the unchanged revision on the next poll;
after success, unchanged revisions are skipped as before.
