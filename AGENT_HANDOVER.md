# AGENT_HANDOVER.md

_Current-state snapshot. Update it after every meaningful unit of work._

## Current state (2026-10-06, everything committed)

All owner tasks to date are implemented and committed (both parallel sessions' work, split into
atomic commits). Nothing is pending in the working tree.

- **Shell:** Settings page (agent CLIs with install, per-project board column presets), icon nav
  with a global Board between All projects and Agents, remembered last page, calm dark theme,
  sidebar strip at tablet widths (769–900px).
- **Phone layout (≤ 768px, DESIGN.md §10.1):** bottom tab bar (`MobileTabBar`: Home, Projects,
  Board, Agents, Settings) replaces the top nav; Projects opens the sidebar full screen
  (`useProjectPanel` in `client/src/projectPanel.ts`, tied to the history entry so navigation
  closes it); safe-area tokens + `viewport-fit=cover`; headers wrap; tabs scroll; the Kanban
  keeps its original layout; dialogs are bottom sheets with a pinned footer; dashboard and Agent work
  rows reflow to two lines; workspace panes stack and hide presets/shortcut help; 40px touch
  targets and 16px field text on coarse pointers; `theme-color` follows `--surface`. Patterns
  taken from the sister apps KdpPublishingPipeline (bottom bar, master/detail) and ApexTide
  (safe areas, touch targets). Verified in Chrome at 360/390px (light and dark), plus 820px and
  1060px for regressions; no horizontal overflow on any page or project tab.
- **Board views (PM-16, DESIGN.md §6):** Notion-style view tabs (Board | List) above the project
  board and the global Board; Board (Kanban) stays the default. List (`BoardListView`) groups
  cards by status under collapsible headers with status pills, 44px rows and a "New" row per
  group; Done starts collapsed. View and collapsed groups persist per browser (`boardView.ts`).
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
- **Boards follow commits:** a commit watcher (`Scanner.watchCommits`, started in index.ts)
  checks each project's HEAD every 15s and applies new commits' card refs (`PM-n` → In progress,
  `Fixes PM-n` → Done), idempotent across same-second commits; no Refresh needed. Agents get a
  `create_card` MCP tool for terminal-started work and are told to reference cards in commits.
- **Pull requests** tab via `gh pr list`.
- **CLI resume:** Claude sessions get a per-process SessionStart hook
  (`scripts/claude-session-hook.mjs`) that reports the live conversation id (follows /resume,
  /clear, compaction) to `/api/agent-hooks/claude-session`; Codex resumes its own rollout from
  `~/.codex/sessions`; any resume that dies within 20s is followed by a fresh start.
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
- **LAN devices stay signed in (PM-37, `server/lan.ts`):** the listener remembers its port in
  `lan_access.port` and retries it for ~3s on restart (old process releasing it) before falling
  back to app port + 100…109; page loads re-send the device cookie (sliding one-year expiry);
  signing in again on a device replaces its entry; `<hostname>.local` is listed after the IPs as
  an address that survives DHCP changes. Not live-restarted here (another session had server
  work in progress); covered by real-socket tests in `server/lan.test.ts`.
- **Phone space savers (PM-36, DESIGN.md §10.1):** headers scroll away (tabs stick), tighter
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
- **Scans** (`server/scanner.ts`) run in the background. `refs_cursor` makes commit refs apply once.
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
- After a reboot, Claude resumes its own pinned conversation. Codex, Antigravity and OpenCode resume
  their latest conversation only when they are the sole session of that CLI in the folder (else
  they start fresh). OpenCode has no read-only mode.
- `react-hooks/set-state-in-effect`: loaders only set state inside promise callbacks, and
  CardDialog resets its form during render. Keep to these patterns, or lint fails.

## Gotchas

- **Session host processes** (`ptyHost`) legitimately outlive the server while sessions run.
  Rendezvous: `<dataDir>/agent-host.json`; diagnostics: `<dataDir>/agent-host.log`.
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
