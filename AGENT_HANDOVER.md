# AGENT_HANDOVER.md

_Current-state snapshot. Update it after every meaningful unit of work._

## State (2026-10-05)

Milestone 1, a working agent CLI integration, and the multi-pane agent workspace are implemented
and verified in the browser.

- **Commit 1:** milestone 1 plus the original agent dispatch.
- **Commit 2:** made the CLI integration actually work (shims, autonomy, change evidence, PTY,
  clean env, id-reuse fixes). Verified with real Claude, Codex and Gemini runs on Windows.
- **Commit 3 (this one):** the Agents workspace. Verified in Chrome:
  - card → "Work on it in a terminal" → Claude got the card's task and wrote the file
  - two panes across two projects
  - shell input, layout persisted across reload, maximise, live badge on the board

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

All owner-requested items to date are implemented (see Research/feature-requests.md, Addenda 1–8).
Add new requests here as they come in.

Dropped on purpose: a theme toggle (it was our idea, not the owner's, and the owner asked for no
rarely used features). The tokens still support `data-theme` if it's ever wanted.

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
- After a reboot, Claude resumes its own pinned conversation. Codex, Gemini and OpenCode resume
  their latest conversation only when they are the sole session of that CLI in the folder (else
  they start fresh). OpenCode has no read-only mode. Gemini ignores `--approval-mode` in folders it doesn't trust yet.
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
