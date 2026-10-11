# AGENT_HANDOVER.md

_Current-state snapshot. Update it after every meaningful unit of work._

- **OpenCode full-log recovery (2026-10-11)**: Detached hosts can keep running obsolete code
  across server reloads. The live October 8 host still suppressed output at 32 MB despite the
  committed rotation fix. Host generation 2 uses a separate authenticated socket/rendezvous.
  The server retains legacy sessions and routes their input/resize/stop/events to the old host;
  new sessions and stopped-then-restarted sessions use generation 2. No bulk terminal shutdown.
  Runtime TiemNet OpenCode session 40 was restarted with its existing conversation, and its
  physical log compacted to about 1 MB with increasing logical offsets. Tests cover migration,
  preserving live legacy sessions, duplicate-spawn prevention and output past the old cap.
  Frontend files reserved for Claude were not edited.

- **Orchestrator Durable Lifecycle, Epoch Fencing, and Scoped Planning (2026-10-11)**:
  - **Lease Owner Epoch & Fencing**: Added migration 15 adding `epoch` column to `orchestrator_lease`. Reclaiming an expired lease increments `epoch`; heartbeat renewal preserves `epoch`. Long-running async dispatches in `executeLeased` renew the lease and fence transitions (`claim` and `assigned`) against stale owners/epochs to prevent conflicting writes if another node takes the lease.
  - **Orphan Dispatch Recovery**: `reconcile` automatically detects claims in `dispatching` state older than 120s with no matching inserted run in `agent_runs` (e.g. server crash before run creation). Automatically recovers orphan claims to `error` cooldown rather than permanently stranding them, allowing retry within the persisted attempt budget.
  - **Scoped Capacity & External Occupancy Partitioning**: `planOrchestration` differentiates between managed workers in scoped projects (`managedWorkers`), external workers in unmanaged projects (`externalWorkers`), and a host safety cap (32). Unmanaged sessions in unrelated projects no longer starve scoped orchestrators, while per-project editing concurrency (1 worker/project) and host safety caps are preserved.
  - **Typed Wait Reasons & Occupancy Reporting**: Decisions emit structured `waitReason` (`active_worker`, `review_required`, `assignment_reserved`, `retry_cooldown`, `retry_budget_exhausted`, `project_capacity`, `managed_capacity`, `global_capacity`, `provider_capacity`, `quota_exceeded`, `quota_unknown`, `no_provider_available`) and occupancy breakdown (`{ managedWorkers, externalWorkers, projectWorkers }`).
  - **Single-Flight Coalesced Execution**: Coalesced rapid manual and scheduled `tick()` requests into a single in-flight execution and at most one queued follow-up execution. Multiple overlapping clicks on "Check now" or "Check all" resolve cleanly together without queueing runaway inspection loops.
  - **Live Execution Status**: Exposes live `status: { executing: boolean, lastTickAt: string | null }` on `OrchestratorState`. The UI displays a live `● Checking…` indicator in the Masters panel header and disables buttons while execution is active.
  - **Plan Preview UI Polish**: Decisions display typed wait reason badges ("Project busy", "Worker limit", "Cooldown", "Needs review"), external occupancy indicators ("Managed: 1 · External: 2"), and exact retry cooldown times.

- Plan preview includes persisted attempts used/remaining, cooldown time, claim blocker,
  actual edit autonomy, single supervisor attempt and review requirement. Read-only inspection
  does not reset budgets, release claims or send terminal input.

- Orchestrator strategy supports Observe (scheduled checks log proposals; no worker dispatch
  or attention-card mutation) and Autonomous board work (existing quota/capacity/review policy).
  Legacy configs default to existing autonomous behavior. Per-master Preview plan is a read-only
  GET endpoint with snapshot time and board decisions, available even while paused. Explicit
  manual attention actions remain separate from scheduled strategy. Broader recovery gaps remain.

- Hide keyboard uses a centered SVG chevron rather than a baseline-dependent text glyph,
  keeping the mobile caret vertically centered within its 44px flex button.

- Keyed dispatch reconciliation now looks up agent_runs by persisted identity directly,
  independent of bounded history snapshots. Manual later runs cannot satisfy keyed intents;
  legacy keyless claims retain timestamp reconciliation. Pre-insertion orphan recovery remains open.

- Append-only migration adds unique optional agent-run dispatch keys and persisted
  assignment intent keys. Supervisor checks before and after async provider validation,
  returning the existing run on repeated dispatch. Orchestrator passes the claim key.
  This establishes durable identity; full pre-run orphan recovery and owner fencing remain open.

- Reviewed rejected/accepted runs whose cards explicitly return to Todo release assigned
  claims for bounded retry; unvalidated/review work remains protected. Orchestrator page
  polls after all four requests settle instead of overlapping interval batches.
  Durable dispatch identity/orphan recovery, lease fencing, preview and typed statuses remain open.

- **Terminal Loading & App Performance Optimizations (2026-10-11)**:
  - **Large Log Tailing Bottleneck Solved**: Real agent logs in `data/agent-logs/` grow up to 10–33.5 MB. Previously, `TerminalView` always started with `offset = 0`, streaming 10–33 MB over SSE in 260+ chunks of 128 KB while hiding the terminal behind `visibility: hidden` until the entire file was parsed by xterm (taking 5–15+ seconds), only for xterm's 5,000-line scrollback buffer to discard the oldest 32.5 MB immediately anyway. Added `MAX_INITIAL_HISTORY_BYTES = 512 * 1024` (512 KB tail), matching xterm's 5,000 scrollback lines. Tailing starts from `totalHistory - MAX_INITIAL_HISTORY_BYTES` for large logs, strips broken leading line fragments on the first chunk, and reveals the terminal in ~50ms.
  - **Preloading TerminalView Chunks**: Eliminated the network waterfall where lazy `TerminalView` chunks only started downloading after `getWorkspace()` and `listAllSessions()` API calls completed. Preloaded `TerminalView` at module scope in `WorkspacePage`, `AgentsPanel`, and `RunCard`.
  - **Workspace In-Memory Layout & Session Memory**: Added module-level `cachedWorkspaceLayout` and `cachedSessions` to `WorkspacePage`. Navigating back to `/workspace` renders panes and sessions immediately without skeleton flicker while background synchronization revalidates state.
  - **Server-Side Disk I/O & Stat Consolidation**: In `supervisor.ts`, replaced duplicate path-based `statSync` calls per session with a consolidated `fileStat` helper. In `OutputLog.readFile` and `logTail`, replaced redundant path `statSync` with `fstatSync(fd).size` and `Buffer.allocUnsafe(len)`. Capped legacy terminal snapshot and geometry inference reads to at most 1 MB from the tail. Lowered terminal stream recovery timeout from 8s to 4s.

- Orchestrator scheduling excludes reserved/cooling-down/exhausted claims before capacity
  reservation, preventing an older blocked task starving ready cards. Tests cover slot
  refill and retry eligibility. Per-instance Check now uses /orchestrators/:id/tick and
  checks only that master; automatic/global checks still cover all enabled masters.
  Durable terminal/orphan claim lifecycle and lease fencing remain outstanding.

- Orchestrator audit and phased upgrade plan saved in docs/ORCHESTRATOR_AUDIT.md.
  P0 priorities: terminal/orphan claim lifecycle, claim-aware capacity and lease fencing.
  Next: scoped checks/preview, typed status, efficient summaries and bounded follow-through.
  No masters enabled or worker input sent during audit.

- Mobile toolbar explicitly displays Status and Actions in their stable grid slots;
  F1–F12 now scrolls with shortcut keys, only Hide keyboard stays pinned. Key glyphs
  use centered flex alignment. Physical-phone verification remains pending.

- Fixed desktop List view Actions popover: eliminated legacy `.work-bulk-menu { position: absolute; top: calc(100% + 4px); right: 0; }` in `agents-toolbar.css` that overrode `styles.css` `position: fixed` and `--bulk-top`/`--bulk-right` popover anchoring (which previously caused top-layer popovers on desktop to render at `top: 100vh + 4px`, completely off the bottom edge of the screen). Wire `positionBulkMenu` across button click, `onToggle`, and window resize/scroll, with resilient programmatic fallback.

- Mobile keyboard strip now portals to document.body to escape pane clipping; standard
  shortcuts are directly scrollable without a More button, with a grouped F1–F12 toggle.
  Pane action menu keeps Auto-continue and icons on one row. Expanded filters use compact
  44px fields with Kind/Search paired and Clear filters right-aligned. Phone QA pending.

- CLI image picker supports multiple photos on desktop/mobile. Uploads run sequentially
  to bound image-processing memory; individual failures name the photo and do not skip
  remaining selections. Paths are added to the draft without submitting the message.

## Orchestrators tab redesign, master cards & decision pruning (2026-10-11)

- **Layout Hierarchy & UX**:
  - Reordered the Orchestrators page to place **Masters** at the top as the primary status and operational view.
  - The configuration form is now collapsible: hidden by default behind `+ New master` when masters already exist, and automatically shown when no masters exist or when editing an existing master.
  - Reorganized the configuration form into 3 structured sections: **Scope & Identity**, **Worker Providers & Concurrency**, and **Policies & Quota**.
- **Rich Master Instance Cards**:
  - Enhanced master instance rows into clean cards with real-time status dots (green pulsing for Active, gray for Paused).
  - Added metadata pills: Project Scope (`📁 All projects` / `📁 Project one`), Enabled Providers (`🤖 Codex, Claude Code`), Concurrency Limits (`⚙ Up to 6 workers`), Quota Reserve (`🛡 15% reserve`), Dashboard Attention follow-up (`⚡ Attention follow-up`), and Unknown Quota allowed flag (`⚠ Unknown quota allowed`).
  - Added **Scope Board Progress**:
    - Aggregates To do, In progress, Review, and Done card counts across the projects in the master's scope.
    - Proportional multi-segment progress bar reflecting completion percentage.
    - Direct `View board →` link targeting the scoped project's board or all boards.
  - Added **Live Active Workers in Scope**:
    - Displays active running/queued agent runs and active sessions for projects in scope.
    - Shows pulsing status indicator, run/session name, provider badge, project name, card PM link, and direct link to terminal / workspace.
    - Faint empty indicator when no workers are active.
  - Added **Start / Pause / Run now**:
    - Individual masters have direct `Check now` trigger button in addition to Start/Pause, Edit, and Delete.
  - Added **Delete Master** capability using the standard destructive `ConfirmDelete` dialog pattern:
    - Added `delete(id)` in `server/orchestrator/service.ts`.
    - Added `DELETE /orchestrators/:id` in `server/orchestrator/routes.ts`.
    - Added `deleteOrchestrator(id)` in `client/src/api.ts`.
  - Added check feedback: "Check now" updates to "Checking…" and disables when execution is busy or if all masters are paused.
- **Decision History**:
  - Server-side deduplication collapses redundant 30s tick events for the same `(orchestratorId, cardId, action, message)` with a running `count` (`280×`).
  - Clean client timeline view with action badges, card link tags (`PM-{cardId}`), repetition pills, and monospace timestamps.
  - Added filter chips (`All`, `Dispatched`, `Waiting`, `Errors`) with live count badges and a "Clear history" action (`DELETE /orchestrators/events`).
  - Capped initial visible events at 25 with a "Show older decisions" expansion button.
- **Test Coverage**:
  - Added tests in `OrchestratorPage.test.tsx` verifying card rendering, scope board progress counts and progress bar, live workers grid with direct links, form toggling, draft editing, deleting with `ConfirmDelete`, and decision history filtering/clearing.
  - Added test in `service.test.ts` verifying deleting orchestrators.
  - Fixed jsdom race condition in `WorkspacePage.interactions.test.tsx` by ensuring the second pane's textarea mounts before firing Alt+2.

## Orchestrator Needs Attention resolution & Being worked on tracking (2026-10-11)

- **Needs Attention Queue & Autonomous Resolution**:
  - In each master instance card, added a dedicated **Needs Attention** section tracking project attention signals (uncommitted files, unpushed commits, stale repos, failed scans, missing directories) and failed runs within that master's scope.
  - Added **Autonomous Resolution Action (`⚡ Resolve attention` / per-item `Resolve`)**:
    - Dispatches agent workers directly (`supervisor.dispatchCard`) to investigate, validate, test, commit, and push pending changes to resolve the issues.
    - If provider capacity is full or reserved, ensures a follow-up card (`Follow up Dashboard attention`) is queued in `todo` on the board for the next orchestrator cycle.
    - If a scan had failed, triggers re-scan to resolve.
    - Endpoints: `POST /orchestrators/resolve-attention` and `POST /orchestrators/:id/resolve-attention`.
  - Added **Auto-Pruning and Dismissal (`Prune / Dismiss`)**:
    - Automatically prunes resolved or obsolete follow-up cards (marking them `done` with an audit note) when a project's attention signals clear or are resolved on disk.
    - Endpoints: `POST /orchestrators/prune-attention`, `POST /orchestrators/:id/prune-attention`, `POST /orchestrators/dismiss-attention`, and `DELETE /orchestrators/dismiss-attention/:projectId`.
    - Added `pruneDashboardAttention` toggle in master orchestrator config and master card pills (`🧹 Auto-prune attention`).
- **"Being Worked On" Real-time State & Tracking**:
  - Replaced the standalone Live Workers block with an enhanced **Being worked on** section aggregating all active work in scope:
    - Live worker runs (running or queued) with provider badges and terminal links.
    - Interactive agent sessions with terminal links.
    - Board cards currently `in_progress` or `review` across projects in scope (`api.listCardsInFlight()`), with direct links to the board card.
  - In the **Needs Attention** queue, items that have an active run, session, or in-flight card show a live pulsing cyan/blue badge: `● Being worked on`, linking directly to the running worker or terminal (`Terminal →`). Unattended items provide the primary `Resolve` action button and secondary `Dismiss` action.
  - Master header shows `${beingWorkedOnCount} being worked on` live status chip alongside `${totalAttentionCount} issues` / `Clean`.
- **Test Coverage & Verification**:
  - Unit and integration tests added in `server/orchestrator/attention.test.ts`, `server/orchestrator/service.test.ts`, and `client/src/pages/OrchestratorPage.test.tsx`.
  - Full project test suite: 73 test files, 335 tests passing.
  - Typecheck (`npm run typecheck`) and linter (`npm run lint`) pass with 0 errors.

## Stale restart failure suppression & mobile layout polish (2026-10-10)

- Stale "Restart failed" progress and bad/red status dots are cleared and suppressed when a session is actively running, both on the server (in supervisor `toSession`) and on the client (in `AgentWorkList` `stateLabel`).
- Fixed inline rename pencil button spacing: hugs the session name with a 2px gap and 20px button (22px on touch with invisible hit-area padding), eliminating excessive separation.
- Fixed mobile list row facts formatting: suppressed the stray leading interpunct separator on the first visible fact line (`· up ...`).
- Added unit tests covering running sessions with stale restart progress in `AgentWorkList.test.ts`.

## Memory and overhead optimization in progress

- Scheduler start/stop generation prevents a slow old tick from reviving its timer chain
  after restart. Regression covers restart while pending and confirms one recurring chain.
- Current verification: 321 tests across 73 files passed; client/server typechecks, lint,
  formatting and production build passed. Browser verification unavailable: cua inventory
  has no browsers and createBrowserTab reports iab unavailable. Whole-app memory audit ongoing.

- App routes now load lazily; navigation/sidebar stay outside Suspense. Identical production
  builds measured by scripts/benchmark-route-bundle.mjs: initial static JS 673,293 ->
  307,844 bytes; gzip 208,873 -> 98,147 bytes. Selected-page dependencies load afterwards;
  this is startup transfer/parse savings, not a whole-app retained-memory measurement.
- npm run build now uses scripts/build.mjs with explicit production NODE_ENV for Vite and
  server compilation, preventing inherited development settings from shipping dev React.

- Host entries release AgentProc references on exit, retaining pid/exit/log metadata
  for reconnect/list until forgotten. Real temporary-host lifecycle test passed for
  exit metadata, stopped input rejection, respawn and forget. Active host unchanged.

- PTY host coalesces disk-backed data once a client's socket backlog reaches 256 KiB.
  On drain or before a control/unsaved event it emits a forward-offset empty data event;
  OutputLog invalidates its byte window, notifies viewers, and replays skipped bytes from disk.
  No socket disconnect or CLI restart is introduced. Unsaved/partial writes are never coalesced.
  Tests exercise 10,000 Unicode chunks, exact disk replay, normal output, and exit ordering.
  Live persistent host remains on its previously loaded code until its normal lifecycle ends;
  no active sessions were stopped to apply this change. Whole-app measurement remains pending.

- Stopped PTY replay skips full-log legacy geometry/snapshot parsing when its initial
  output already includes recorded pm-size geometry. The first replay chunk remains
  bounded at 128 KiB instead of allocating/parsing an archive up to 32 MiB.
  Archives without initial geometry retain the existing legacy fallback.
- Host backpressure audit found socket disconnect currently means process exit to the
  supervisor. Do not drop slow sockets without implementing reattachment first; that
  would violate the no-regression requirement. Backpressure work remains outstanding.

- Whole-worktree regression audit: both typechecks and ESLint passed; corrected seven
  existing formatting failures. Full Vitest run passed 302 tests in 67 files.
- Read-only live snapshot: server processes around 60–200 MiB working set; PTY host
  PID 29652 had ~2.5 GB private committed memory (working set much lower). These are
  point-in-time observations, not proof of a leak or before/after savings.
- Next audit target: host broadcast calls socket.write without checking backpressure;
  investigate bounded delivery with disk replay and reconnect before changing semantics.
  Existing host disconnect/recovery path must preserve live sessions and exit notifications.

- Browser agent lists, board cards and board run summaries use an eight-project LRU
  revisit cache rather than retaining every visited project forever. Mounted view state
  remains intact; evicted project data reloads through the existing API on revisit.
  Cache tests cover recency, replacement and retained external references; board/workspace
  regression suite passes. This bounds project count, not per-project payload bytes.

- Paused orchestrators skip provider checks, history scans and lease writes. Automatic
  ticks schedule 30s after completion instead of queueing behind slow ticks; 10 tests pass.
- Mobile terminal keys now use a single horizontal scrolling strip with 44px pill targets,
  pinned More/Hide keyboard controls and added Insert/Delete. Existing shortcuts and
  F1–F12 remain; terminal regression tests pass. Physical-phone visual check remains.

- OutputLog caches UTF-8 bytes in 4 KiB blocks rather than per-output-event strings.
  Tiny-event regression: 100,000 single-byte events occupy 25 blocks rather than
  100,000 entries. Reads no longer re-encode each retained chunk per viewer.
- Cache is strictly bounded to 256 KiB even for a single oversized append; complete
  logs remain on disk. Unicode replay across read/block/eviction boundaries is tested.
- Finished sessions/runs release byte blocks once disk holds every byte; failed/missing
  disk writes preserve the memory fallback. Real-process tests check eviction and replay.
- Reproduce the microbenchmark with node --expose-gc --import tsx
  scripts/benchmark-output-cache.mjs legacy (then blocks in a separate process).
  Ten 100,000-event logs: retained heap + buffers 49,175,112 -> 1,144,856 bytes;
  ingestion 203 -> 97 ms, 100 reads 9,685 -> 15 ms. Synthetic tiny-event workload;
  not a whole-app memory result. Small events encode directly without temporary buffers.
- Broader goal remains active: whole-app runtime measurements,
  stopped-terminal geometry scans and client background work still need investigation.
- Workspace session/run refresh now schedules after each request settles, preventing
  overlapping requests on slow servers; cleanup ignores late poll responses.
  serialPoll tests cover slow responses, cleanup and retry after errors.
- Orchestrator has optional Follow up Dashboard attention: shares signal extraction with
  Dashboard, creates one board task per attention episode, extends existing open tasks,
  respects project scope and skips projects with live workers. Missing folders go to review.
  Other follow-ups use existing dispatch/quota policy. Old configurations remain unchanged
  unless opted in. Completed/deleted follow-ups are not recreated while signals persist.
- LAN settings now has Scan pairing QR on local/remote panels. Uses file/photo capture
  (camera picker) because HTTP LAN origins cannot use getUserMedia/BarcodeDetector.
  Added jsqr for cross-browser on-device image decoding, lazy-imported only on scan;
  canvas limited to 1600px longest edge, object URLs released. No photo upload.
  Validates local-network root pairing URLs and shows explicit Open sign-in page.
  Real generated QR decoding and URL-validation tests pass; physical-phone test pending.
- Mobile Filters is icon-only with active-count badge and full accessible label;
  desktop retains text. Toolbar expansion geometry remains stable.

## Filtered Actions menu and batch messages

- Batch sending shows completed/total progress, current terminal and paste/Enter stage,
  sent/failed counts and a progress bar. Counts advance only after each terminal's attempt
  settles; successful recipients remain excluded from retry. Delivery is distinct from reply.

- Actions uses the native popover toggle exclusively. Removed a delayed fallback that
  reopened the menu immediately after a second click closed it; positioning remains.

- Show in panes always displays its target count; more than four matches says (first 4),
  reflecting the existing four-pane limit.

- Mobile message composer initially focuses its heading, leaving keyboard opening to
  the user; textarea uses 16px touch sizing. Desktop still focuses input without scrolling.
- Mobile list toolbar keeps Status/Filters/Actions in fixed grid slots when expanded;
  extra filter fields occupy a separate full-width grid below. No toggle resizing.
  Focus, filter and workspace regression tests pass; physical-phone visual check pending.

- Show in panes is the first action inside the Actions menu on desktop and mobile.

- Desktop Actions popover anchors beneath its button, repositions on scroll/resize,
  and flips above when needed. Phones retain the compact bottom sheet.
- Send message snapshots running, non-restarting filtered sessions, offers a continue
  preset, pastes and submits input, reports partial failures and retries only failures.
  Input appends to existing drafts; shell sessions execute it. No real terminals were messaged in tests.

## Blank terminal recovery and mobile restart status (2026-10-10)

- Terminal traffic waits for xterm.open, avoiding a resume-effect race before initialization.
- SSE drain state reveals parsed history even if the mount's logBytes snapshot is stale;
  empty logs no longer stay hidden. A silent stream gets an HTTP recovery read after 8s;
  stream failures recover through HTTP before reconnecting. Existing output is preserved.
- Loading/waiting/reconnecting notices replace unexplained blanks, with Retry on failures.
- Restart progress has a compact independent header badge, on a small second line on phones;
  it remains visible with the actions menu closed. Mobile action menus wrap within the viewport.
- Regression coverage includes stale/empty history, failed/silent streams, initialization,
  stopped geometry and terminal persistence. No CLI process was restarted for these checks.

## Master orchestrator in progress (2026-10-10)

- Full requested scope and integration checklist: docs/ORCHESTRATOR.md.
- Implemented pure scheduler in server/orchestrator/planner.ts: project scope, ordered
  provider selection, quota freshness/reserve, concurrency reservations, live assignment
  deduplication and review handoff. Four scheduler tests and typecheck pass.
- Added durable instance settings/events, validated list/save/tick API, serialized dispatch
  with per-action capacity rechecks, and production 30-second ticks with shutdown draining.
  No instances were enabled in the user's database. Five planner/service tests pass.
- Still pending: cross-process leases/assignment recovery, retry cooldowns, master tools,
  existing-worker handoff and review coordination. Keep the goal active.
- Added separate /orchestrators control page with persisted scope/provider selection,
  concurrency/quota settings, Start/Pause/Check now, editing and decision history.
  Desktop navigation and mobile Agents tools link reach it. Seven tests and typecheck pass.

## Mobile agent row alignment (2026-10-10)

- Shared agent list rows use consistent name/pencil spacing, flexible project labels,
  aligned status/action rows, 40px action targets and 44px filter toolbar controls.
  Actions wrap only when needed; Stop uses its labelled icon on mobile.
- CSS formatting and typecheck verified; phone screenshot verification remains.

## Filtered terminal persistence (2026-10-10)

- The selected list terminal is resolved from all sessions, independently of visible rows.
  An Idle-to-Running update while typing no longer unmounts the terminal or loses focus.
  Filters still constrain list rows and bulk actions.
- Audited project Agents tabs and workspace panes for filter-dependent selection. Regression
  coverage verifies every status tab, search and Kind filtering on desktop and mobile keeps
  the same terminal mounted with its draft intact.

## List view cleanup (2026-10-10)

- Auto-continue buttons and continuation messages are removed from List view rows and
  the docked terminal panel (`Pane inList`). Auto-continue is exclusive to Panes view terminals.
- Docked terminal panel in List view omits the pane index number ("1") and only renders if the
  selected session/run matches the active filters.
- Stale cancellation messages are suppressed when Auto-continue is disabled.
- Supervisor continuation check only cancels if a saved conversation actually changed.

## Multi-select agent work filters (2026-10-10)

- Agent, Project and Kind dropdowns support multiple choices. Status is single-select
  on desktop and mobile. Choices are OR within a group and AND across groups.
- Menus stay open while toggling, show selected counts, and All clears that group.
  Saved single selections remain compatible; multi-selections persist in localStorage.

## Restart preservation and explicit Rename (2026-10-10)

- Manual resume failures keep the saved conversation target and report failed progress;
  they cannot silently auto-relaunch a fresh conversation. Missing Claude transcripts report
  an actionable error. Codex discovery reads larger metadata records (256 KiB).
- Names have a separate accessible pencil Rename action, with larger touch targets.
- Added PM-58 to the project board: refine Auto-continue using the supplied Claude desktop
  checkbox, usage-limit status, reset time, details and retry reference.
- Typecheck and 30 rename/workspace/usage/agent tests passed; final server checks also passed.

## Agents list controls (2026-10-10)

- Mobile status filtering uses a compact dropdown with live counts rather than clipped chips.
  Desktop keeps status chips and the visible agent/project/kind/search filters.
- Auto-continue is a direct pressed-state button instead of a one-item overflow menu.
  Mobile row actions wrap as needed. Typecheck and 11 filter/workspace tests passed.

## Mobile CLI focus update (2026-10-10)

- Mobile density follow-up: compact continuation popover, icon Stop, card key in the facts
  line, aligned 44px Filters/Actions, shortened mobile bulk trigger, neutral New toggle.
  Top-layer popovers avoid list overflow clipping and dismiss with outside click/Escape.
  Browser automation failed to initialize in this environment; visual mobile QA remains.

- Restart UX: dedicated POST restart endpoint serializes Stop/Start and exposes shared
  stopping/starting/restoring/failed progress in rows and terminal headers. Bulk restart
  uses the same endpoint. Readiness needs new output plus recognized CLI activity.
- Codex Auto-continue: one-shot opt-in persisted in settings, checked server-side every 10s.
  Recent limit denial + near-exhausted window with known reset required; waits through all
  matching windows plus 30s, validates conversation, idle/empty input, then claims before
  writing a continuation. Manual input/lifecycle changes cancel. Long offline gaps cancel.
  Unknown reset times remain watching; Claude's native feature handles Claude continuation.
  Live provider reset has not been exercised; regression tests cover parsing and lifecycle.

- Fixed shared TerminalView autofocus: history replay hides the input, so focus now waits for
  the final replay frame. Returning to a preserved project tab also restores keyboard focus.
- Interactive terminals show an accent outline only while their input has real keyboard focus.
  Removed the focus text badge. Added replay and tab-resume regression tests.

## Current state (2026-10-06, everything committed)

All owner tasks to date are implemented and committed (both parallel sessions' work, split into
atomic commits). Nothing is pending in the working tree.

- **Shell:** Settings page (agent CLIs with install, per-project board column presets), icon nav
  with a global Board between All projects and Agents, remembered last page, calm dark theme,
  sidebar strip at tablet widths (769–900px).
- **Phone layout (≤ 768px, DESIGN.md §10.1):** bottom tab bar (`MobileTabBar`: Home, Projects,
  Board, Agents, Settings) replaces the top nav; Projects opens the sidebar full screen
  (`useProjectPanel` in `client/src/projectPanel.ts`, tied to the history entry so navigation
  closes it); safe-area tokens + `viewport-fit=cover`; headers wrap; tabs scroll; both Kanbans
  stack their columns at ≤ 900px; dialogs are bottom sheets with a pinned footer; dashboard and Agent work
  rows reflow to two lines; workspace panes stack and hide presets/shortcut help; 40px touch
  targets and 16px field text on coarse pointers; `theme-color` follows `--surface`. Patterns
  taken from the sister apps KdpPublishingPipeline (bottom bar, master/detail) and ApexTide
  (safe areas, touch targets). Verified in Chrome at 360/390px (light and dark), plus 820px and
  1060px for regressions; no horizontal overflow on any page or project tab.
- **Board views (PM-16, DESIGN.md §6):** Notion-style view tabs (Board | List) above the project
  board and the global Board; Board (Kanban) stays the default. List (`BoardListView`) groups
  cards by status under collapsible headers with status pills, 44px rows and a "New" row per
  group; Done starts collapsed. View and collapsed groups persist per browser (`boardView.ts`).
- **Sticky board column headers (PM-56, DESIGN.md §2):** both boards' column headers stick under
  the page's sticky chrome (`.col-stick`, offset from `useStuckTop` in `client/src/stuckTop.ts`),
  with a shadow only while stuck (scroll-state container query, progressive). The project board
  no longer scrolls sideways (that overflow box would trap sticky): columns share the width like
  the global board and stack at ≤ 900px. Verified on a scratch instance: desktop headers hold as
  one row flush under the head on both boards; 390px phone pins under the Board head / project
  tab bar; no sideways scroll.
- **Boards:** project and global boards create cards through the full CardDialog (notes, staged
  images, hand-to-agent); the project is required on the global Board. Dashboard tiles link to
  /board?show=planned|active. Card images: data folder only, lightbox preview.
- **Agents:** one Agent work list (sessions + runs) with facts, token usage (Claude), rename in
  place, names flush left with the card tag, state and actions in fixed right-hand columns, and
  official provider marks where verified (Claude Code, OpenCode; others the generic
  glyph). Workspace Panes / List with a resizable, maximisable docked terminal.
- **State (PM-14):** "running" means the CLI's last screen frame shows busy chrome or a still-
  running background shell/subagent; "idle" means it is at its prompt; unknown CLIs (shell,
  custom) fall back to output recency (`server/agents/activity.ts`, `tailState`).
- **Providers:** Antigravity (`agy`, flags from `agy --help`) replaced Gemini, which is removed
  entirely (old Gemini rows still relaunch from their saved command, without provider extras).
- **Board MCP** (card-scoped get_card / update_status / add_note / read_image, audited, migration 7) is injected for Claude, Codex and OpenCode. Native images: Codex --image, Claude
  --add-dir, OpenCode run --file; Grok/custom keep the path list.
- **Claude resume:** if the pinned conversation has no transcript, a relaunch starts a fresh
  conversation under a new pinned id (and stores it) instead of crash-looping on
  "No conversation found".
- **Animation-only tails** (Grok's idle welcome screen redraws a braille logo forever) read
  idle: a tail with no letters or digits is redraw chrome, not work.
- **Agents tab selection** is remembered per project (`pm.agents.selected`), across project
  switches and restarts.
- **Boards follow the work, no agent needed** (`server/analysis/cardRefs.ts` rules,
  `Scanner.applyCommitRefs` / `applyPullRequestRefs`): every 15s any project whose local branches
  moved is read on all branches (default-branch commits, commits only on other branches, branch
  names); every 2 min GitHub PRs via `gh` (projects with a GitHub remote; 30 min back-off on
  failure). Mention → In progress, unmerged `Fixes`/open PR → Review, merged `Fixes`/merged PR →
  Done; forward-only; each event applies once (settings `ref_events_seen:<id>`, seeded from the
  old `refs_cursor` so history never replays). History is path-limited (`-- .`), so commits that
  change no files are ignored. Agents get a
  `create_card` MCP tool for terminal-started work and are told to reference cards in commits.
- **Pull requests** tab via `gh pr list`.
- **CLI resume:** Claude sessions get a per-process SessionStart hook
  (`scripts/claude-session-hook.mjs`) that reports the live conversation id (follows /resume,
  /clear, compaction) to `/api/agent-hooks/claude-session`; Codex resumes its own rollout from
  `~/.codex/sessions`; Grok pins `--session-id` and resumes it (fresh if Grok never saved it);
  OpenCode (`opencode session list` from the session's folder) and Antigravity (its per-
  conversation databases name the workspace) are looked up at each relaunch
  (`server/agents/conversations.ts`). Any resume that dies within 20s is followed by a fresh
  start. Manual **Start** resumes too (it used to relaunch the original command, replaying the
  first prompt).
- **Names ↔ CLI /rename:** `syncTitles` (every 10s) sends pending app renames as `/rename` when the
  CLI is idle and adopts manual CLI renames (Claude custom-title, Codex session_index, Grok
  title_is_manual). State in settings `session-rename:<id>` / `session-cli-title:<id>`.
- **Running vs idle:** Claude sessions report turns through the same hook (UserPromptSubmit, Stop,
  waiting Notifications, Subagent start/stop) into `server/agents/turnState.ts` (in memory; a
  "running" with a screen silent for 60s counts as idle, since Esc skips Stop). Other CLIs use the
  screen patterns in `server/agents/activity.ts`. Sessions started before this need one restart.
- **Port sharing:** the server also listens on `[::1]` and the launcher probes both loopbacks, so
  another app on the same port (0.0.0.0/::) can't capture `localhost` (seen with a Next.js app on
  5180). Hook and board bridge scripts call 127.0.0.1.
- **Sidebar custom order:** "Custom order" sort with grip handles (drag or ↑/↓), order saved in
  settings `project_order` (`client/src/projectOrder.ts`, after KDP's Library custom sort).
- **Auto refresh:** the stalest project is rescanned once 15+ minutes old (one scan at a time).
- **Agent permissions** (Settings): global level + per-CLI inherit/own, translated into each CLI's
  flags/config (`server/agents/permissions.ts`); applied to sessions at launch, default for runs.
- **LAN access** (Settings, opt-in): separate listener, devices sign in with a 4-character
  single-use code (`server/lan.ts`); see CLAUDE.md security model.
- **Limits on Agent work (PM-18, PM-42):** `LimitsStrip` is a slim section of its own below both
  Agent work lists and their terminal, once per CLI in the list (`useAgentLimits` in
  `client/src/agentLimits.ts`, shared with Settings and the sidebar card).
- **Phone terminals (PM-53, PM-54):** swipes become wheel events in `TerminalView` (verified:
  mouse-mode CLIs get SGR wheel reports, e.g. `ESC[<64;…M`); Image button + image paste/drop
  upload to `POST /api/agent-sessions/:id/images` (`server/attachments.ts`) and paste the path
  via `pasteRef` (xterm `paste`). Live check: a temporary Claude Code session showed
  `[Image #1]` for the pasted path; the session and its images were deleted after.
- **Agents List view space (PM-50, PM-52):** no title row, Plan usage in the toolbar (List view),
  terminal-first default split (`dockHeight` null until dragged). Desktop 903px window: terminal
  380 -> 508px; phone 390x844: 253 -> 329px, no sideways scroll. Phone Plan usage section cards
  wrap (name above windows).
- **Sidebar project count (PM-43):** in the All projects link subtitle; the footer row is gone.
- **Claude limits + sidebar card (PM-17, PM-41):** launched Claude sessions run
  `scripts/claude-statusline.mjs` as status line (recorder -> `<dataDir>/claude-limits.json`, then
  the user's own status line, output unchanged); `claudeLimits` reads it. Verified: recorder with
  and without a user status line (stand-alone), parsing, UI. Not yet seen live: Claude only fills
  `rate_limits` after a reply in a session started/restarted with the new settings.
  `PlanUsage` card in the sidebar footer (collapsible, `pm.sidebar.usage`).
- **Usage limits (PM-17):** Settings → Agent CLIs shows Codex's 5-hour/weekly
  windows from `rate_limits` in `~/.codex/sessions` rollouts (`server/agents/limits.ts`, GET
  `/api/agent-limits`, 30s cache; newest 3 day folders, tail reads of the newest 4 files, latest
  report wins, reset windows read 0%). Claude Code: only the status-line JSON carries
  `rate_limits.five_hour/seven_day` (docs: code.claude.com/docs/en/statusline); hooks, `-p` JSON
  and local files don't. Next step would be a recorder status line for launched Claude sessions
  that chains to the user's own `statusLine` command; deferred while another session reworks
  session launching (supervisor/providers). PM-18 (limits on Agent work rows) builds on this.
- **LAN port (PM-49):** the listener binds the app's own port on each LAN address (specific
  addresses never clash with the loopback listeners, on any OS), re-binding when the addresses
  change (30s check); only if that fails does it fall back to the remembered/+100 port below.
- **LAN devices stay signed in (PM-37, `server/lan.ts`):** the fallback listener remembers its
  port in `lan_access.port` and retries it for ~3s on restart (old process releasing it) before
  falling back to app port + 100…109; page loads re-send the device cookie (sliding one-year expiry);
  signing in again on a device replaces its entry; `<hostname>.local` is listed after the IPs as
  an address that survives DHCP changes. Not live-restarted here (another session had server
  work in progress); covered by real-socket tests in `server/lan.test.ts`.
- **Phone sticky tops (PM-39):** Home/Board/Settings headers stay sticky on phones, compact
  (no subtitle); project pages pin only their tabs (`phone-tabs-only`).
- **Phone space savers (PM-36, DESIGN.md §10.1):** project headers scroll away (tabs stick), tighter
  gutters/panels, 3-across stats, capped dashboard lists, one-row Agents toolbars, aligned work
  rows. Verified at 390px on Home, Agents (workspace + project tab), project, Board, Settings.
- **Phone over LAN (PM-32):** verified end to end with a scripted iPhone client through the real
  gate: sign-in page, 303 + cookie, shell with mobile metas, app modules, every main API, live SSE
  output, writes, LAN settings refused, device signed out after. Phone-side fixes: LAN panel is a
  note on remote devices, project path is plain text there (open-folder refused from LAN), a
  signed-out device reloads into the sign-in page, Add to Home Screen icon + metas. Not covered:
  Vite HMR WebSocket over the LAN port (no upgrade proxy; phones reload by hand in dev), and a
  real handset (this machine's network profile is Public, with Node allowed inbound on Public).
- **Also:** Ctrl+V pastes in terminals; agent icons in pickers; sticky global Board header;
  workspace list filters (status chips with counts, agent, project, kind, search).
- **Verification (this snapshot):** both typechecks, lint on every changed file, Prettier, and
  154+ tests pass (`npx vitest run --maxWorkers=1`). Browser QA in Chrome on a scratch instance
  (port 5290): agent rows aligned (measured), sidebar slots/menu (measured), Board create flow.
  Not verified live: an MCP tool call or native image inside a running provider.

**Gotcha (low RAM):** when other apps hold most memory, `tsc`, ESLint and Vitest workers die with
"Fatal process out of memory: Zone". Run tsc with `NODE_OPTIONS=--max-old-space-size=4096`, lint
files in small batches, and Vitest with `--maxWorkers=1`; they pass.

## Earlier state (2026-10-05)

Milestone 1, a working agent CLI integration, and the multi-pane agent workspace are implemented
and verified in the browser.

- **Commit 1:** milestone 1 plus the original agent dispatch.
- **Commit 2:** made the CLI integration actually work (shims, autonomy, change evidence, PTY,
  clean env, id-reuse fixes). Verified with real Claude and Codex runs on Windows.
- **Commit 3 (this one):** the Agents workspace. Verified in Chrome:
  - card → "Work on it in a terminal" → Claude got the card's task and wrote the file
  - two panes across two projects
  - shell input, layout persisted across reload, maximise, live badge on the board

## State (2026-10-05, UI stability + sticky chrome, uncommitted)

- Tab/project switches no longer flicker or shift: keep-mounted tab panels, per-project module
  caches, hidden tabs pause polling/streams, mirrored skeletons, rename box keyed by project
  (DESIGN.md §7 stability rules).
- Shared `Dropdown` atom for toolbar/menu pickers (KDP `opp-select` anatomy); workspace project
  - provider selects converted (DESIGN.md §6).
- Spacing scale + symmetry rules (DESIGN.md §13); strays normalised in `styles.css`.
- Dashboard + project headers/tabs are sticky (`.sticky-head`); banners scroll away.

## Product brief

`Research/feature-requests.md` is gitignored and local only. It's the owner's brief plus addenda;
read it before product work. `/References` is empty.

- **Done:**
  - folder tracking
  - code/disk/git stats and charts
  - per-project Kanban and commit-ref auto-moves
  - cross-project dashboard and project sidebar
  - agent runs (dispatch → evidence → validate)
  - persistent PTY sessions
  - multi-pane Agents workspace wired to the board (DESIGN.md §12.2)
  - dashboard "Commits by project" stacked chart (DESIGN.md §5)
  - sorting (Research Addendum 8):
    - Rankings sort by Lines, Size, Commits, Commits 30d, First commit, Last commit, Planned
      and Active tasks.
    - The sidebar sorts by A–Z, Recently active, Newest project and Most code.
    - Projects without data for a column always sort last.
  - workspace polish: keyboard shortcuts, drag-to-swap panes, font size, → Review from a pane
  - session host: sessions survive server restarts (DESIGN.md §12.3)
  - attach a card to a running session: `POST /api/agent-sessions/:id/card`. The task is
    bracket-pasted and submitted, only into AI CLI sessions (never shells). Auto-named sessions
    follow the card.
  - one server per data folder, launcher watchdog, schema repair

## Roadmap (owner-requested, in priority order)

Addenda 1-9 are implemented except for verified native Grok/custom image input and automatic isolated MCP configuration for those providers. Browser QA of the Oct 06 card, pull-request, and board-history UI passed on the live dev server; a live provider image/MCP run has not.

- **Done since:** board column presets per project (Settings → Boards): Full flow, Simple
  (To do/In progress/Done), Capture flow (Backlog/In progress/Done). Cards in hidden columns
  keep their status everywhere else.

System / Light / Dark theme switching is implemented at the owner's request (Addendum 9).

Owner preferences to keep applying (Research Addenda 4 and 7): simple over feature-rich, no rarely
used options, never lose sessions, no layout shift.

## Architecture

See the map in `CLAUDE.md` and the agent design in DESIGN.md §12–12.1.

- One Node process serves both the API and the UI on one port. In dev, Vite runs in middleware mode.
- SQLite via `node:sqlite` at `data/projectmanager.db`. Agent logs are in `data/agent-logs/`.
- **Scans** (`server/scanner.ts`) run in the background and apply card refs too (same apply-once
  events as the watchers).
- **Agents** (`server/agents/`):
  - `providers.ts`: catalog plus per-autonomy flags.
  - `resolve.ts`: unwraps Windows npm `.cmd` shims, so no shell is ever used.
  - `proc.ts`: PTY/pipe adapter and the clean agent env.
  - `gitChanges.ts`: run change evidence.
  - `supervisor.ts`: lifecycle, persistence, resume, input queue.
  - `routes.ts`: API including the SSE stream and resize.
- Migrations are append-only in `server/db.ts`.
  - Migration 3 added `agent_runs.autonomy`, `agent_runs.changes_json` and
    `agent_sessions.terminal`.
  - Migration 4 added the `settings` table (workspace layout) and `agent_sessions.card_id`.
- **Workspace:** `client/src/pages/WorkspacePage.tsx` (presets, `placeSession`, panes). The API
  is `GET /api/agent-sessions` (all projects) and `GET/PUT /api/workspace`.

## Launcher

- Entry points: `npm run launch`, `launch.bat`, `launch.ps1`, `./launch.sh`.
- Preferred port: `PORT` (env or `.env`), else `package.json` `config.port` = 5180.
  - If busy, it tries +1, +2 and so on, up to 50 ports.
  - It recovers from a port race via the server's `[server] EADDRINUSE` line.
- Verified 2026-10-05: fallback to 5181 works, and stopping the launcher leaves no orphan.

## Known issues and tech debt

- Complexity is a heuristic (branch tokens per line).
- Client tests (`client/**/*.test.{ts,tsx}`, Testing Library on jsdom via
  `// @vitest-environment jsdom`) cover the board, workspace placement and interactions
  (shortcuts, swap, text size), the terminal (fake xterm and EventSource: streaming, replay
  dedupe, keystrokes, polling, live font size), the commits chart and formatting.
- **Linux:** `node-pty` has no Linux prebuild and compiles from source. Without build tools it's
  skipped (it's optional), and sessions fall back to pipes, where interactive AI CLIs don't work.
- Card IDs (`PM-n`) are never reused: `nextCardId()` keeps a high-water mark in `settings`
  (`card_id_high_water`) because the table has no AUTOINCREMENT. Agent records rely on `log_path`
  identity for the same reason.
- When a CLI's own conversation can't be found (never saved), OpenCode and Antigravity fall back to
  "latest" only when they are the sole session of that CLI in the folder (else they start fresh).
  OpenCode has no read-only mode.
- `react-hooks/set-state-in-effect`: loaders only set state inside promise callbacks, and
  CardDialog resets its form during render. Keep to these patterns, or lint fails.

## Gotchas

- **Session host processes** (`ptyHost`) legitimately outlive the server while sessions run.
  Rendezvous: `<dataDir>/agent-host.json`; diagnostics: `<dataDir>/agent-host.log`.
  A running host keeps its old code: host-side fixes (e.g. log compaction) only take effect
  after it restarts (reboot, or every session stopped so it idles out after a minute).
- **Session log offsets are logical** (`server/agents/logFile.ts`): a log over 32 MB is compacted
  to its last 1 MB, with the dropped byte count in `<log>.base`. Use `logicalSize()` for
  offsets/`logBytes` and `physicalSize()` only for raw file reads; delete logs with `removeLog()`.
- `client/src/components/Dropdown.tsx` and some workspace toolbar changes came from another actor
  (they ended up in commit 104669c).
- Don't put backticks inside double-quoted `node -e` / shell strings: bash runs them as commands
  (this once created a stray empty file named `{`). Use script files for doc edits.

- **One server per data folder** (`server/instance.ts`, record in `<dataDir>/server.json`).
  - A second server exits with `[server] ALREADY_RUNNING <url>`, and the launcher just opens that URL.
  - The launcher passes `PM_LAUNCHER_PID`. The server's watchdog exits (and kills its tsx watcher)
    if the launcher dies, so a hard-killed launcher leaves no orphans.
- **Schema repair** (`repairSchema` in `server/db.ts`): a shipped migration was once edited in
  place, leaving real databases without `agent_sessions.resume_json`. Never edit shipped migrations.

- **Test agent features against a scratch data dir**:
  `DATA_DIR=<tmp> npm run launch`. A second server on the real DB would also supervise
  (relaunch) the same agent sessions.
- If you run ProjectManager from inside Claude Code, the agents still get a clean environment
  (`processEnv()` strips session markers). Don't bypass `processEnv()` when spawning.
- In Claude's interactive interface, Enter is `\r`. The tests use `\r` for PTY input and `\n`
  only for pipe sessions.
- The `S:` drive is slow: ESLint takes about 70s, `tsc` about 60s and `npm run check` a few
  minutes. Run checks in the background.
- npm installs sometimes fail on the first attempt (network); retrying works.
- `npx shadcn add` added a bogus `cn` dependency once, and Rare UI components may import `next/*`.
  Review the diff after adding any component.
- Other projects' dev servers on this machine can eat RAM (TrendRelay's Next server reached 11 GB
  on 2026-10-05 and caused OOM crashes). Check memory before blaming ProjectManager.

## 2026-10-11 batch delivery completion

Fixed zero-recipient completion heading and disappearing progress. Per-terminal server acknowledgments distinguish delivered, queued and failed input. Successful batches close after three seconds; queued/failed batches remain visible. Six component tests pass, covering retained progress, retry isolation, queued input and delayed close. No messages sent to live user terminals during testing.

Settings Agent CLI alignment: scoped settings-cli-list replaces shared baseline alignment with vertical centering. Installed badge text uses a compact line height and cannot shrink. Install/manual status controls also center within the row. Targeted lint and formatting pass; browser visual verification remains pending.

Mobile clipboard: the key bar's Paste button (TerminalClipboard) was removed at the owner's request (PM-61); images still go through the Image button and paste/drop on the terminal, text through the phone keyboard's own paste. Ctrl+A sends control byte 0x01; actual selection behavior depends on the CLI. Orchestrator audit next priority: resolveAttention bypasses configured providers/quota/capacity/claims and must use the policy-controlled dispatch path.

Orchestrator attention policy bypass removed: resolveAttention queues/deduplicates cards then uses serialized tick instead of direct dispatch. Paused/Observe masters do not launch workers; configured providers, quota/capacity and durable assignments govern dispatch. All 24 Orchestrator tests pass, including pause/Observe/provider/claim regression assertions. Broader audit acceptance gates remain open.

Orchestrator lease fencing strengthened: preserve epochs on release, increment on reacquisition, reject expired renewal, fence failure transitions. All 25 Orchestrator tests pass. Existing orphan recovery verified in current code; remaining long-dispatch heartbeat/provider-side fencing requires audit.

Mobile LAN input: Workspace terminal input now coalesces unsent typing while one request is in flight, preventing accumulated per-frame HTTP round trips on high-latency Wi-Fi. Preserves input order, bounded chunks and no automatic replay of failed writes. Eleven queue/workspace tests pass; client typecheck passes. Continue transport audit for project agent panel, SSE connection limits, terminal replay and physical mobile measurements.

Orchestrator long-dispatch heartbeat: leased execution renews every 30 seconds and clears its timer in finally. Provider checks validate ownership before any attention mutations. Simulated three-minute provider wait prevents takeover; 26 Orchestrator tests pass. Project AgentsPanel now uses per-session TerminalInputQueue coalescing, preserving recipient isolation during selection changes and chunking large pastes.

Orchestrator attention API now validates JSON scopes and dismissal kinds; invalid payloads cannot fall back to all projects. 27 Orchestrator tests and server typecheck pass. Corrected audit phase status to partially implemented: full crash/provider fencing, task generations, runtime/mobile and performance gates remain unproven.

Orchestrator planner fairness: round-robin project queues, least recently served via latest card-run ID, board order preserved within project. Proposed workers count against global cap. 29 Orchestrator tests, server types and targeted lint pass. Snapshot-limited history and efficiency benchmarks remain open.

Orchestrator idle efficiency: skip fresh snapshot reloads for non-dispatch proposals; scope card queries. 100 waiting cards use two history reads per tick, with fresh dispatch checks retained. 30 Orchestrator tests, server typecheck and targeted lint pass. Full indexed projections/dispatch-heavy benchmarks remain outstanding.

Orchestrator event churn reduced: per-card latest-observation comparison skips unchanged wait/review/Observe writes and preserves transition timestamps. Operations still record individual occurrences. 30 Orchestrator tests, server types and lint pass. Full repository checks launched next.

Orchestrator UI refresh race fixed: action start invalidates older polls; polling skips while actions are running; completed action invalidates stale responses; duplicate action entry is guarded synchronously. Nine page tests, including delayed poll after save, client typecheck and targeted lint pass. Full npm run check passed typechecks but failed during whole-repository lint with fatal out-of-memory; it did not reach remaining gates. Physical memory observed ~1.9 GB available of ~32 GB; no unrelated processes terminated.

Supervisor dispatch has an internal canCommit callback, evaluated synchronously after provider awaits and immediately before run insertion. Orchestrator validates current lease epoch and enabled/autonomous/provider/project policy there. Denied commit regression asserts no run inserted. Repeated keyed dispatch now validates task identity after the second lookup too. Tests currently running: full suite session 39515 (one worker), focused agent/orchestrator session 29629. Do not restart solely on output silence; poll their handles.

Full regression suite completed with one worker: 355 tests across 76 files pass. Commit fence now rechecks live capacity, quota and card readiness using current policy immediately before insertion; only the owned reservation is excluded. Capacity race callback test passes. 30 Orchestrator tests, focused service tests, server types and lint pass after latest change. Whole-repository lint/format/build/browser gates remain unverified after prior lint OOM.

Planner baseline benchmark added and executed: 1k/10k cards, 100k history, 1/5/20 masters. Results docs/ORCHESTRATOR_BENCHMARK.md. Reveals ~1.85MB bare decision payload at10k cards; summary/pagination is next efficiency priority. Pure benchmark excludes SQL/providers/LAN. No live tasks touched.

Benchmark report restored after interrupted creation; scripts/benchmark-orchestrator.mjs lint passes. Attention all-scope compatibility verified: request helper serializes undefined as {}, routes accept explicit {} while rejecting malformed JSON. Added regression assertion for valid all-scope resolve. Report next priority is compact/paginated preview payload (~1.85MB bare decisions at10k cards).
