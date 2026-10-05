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

## Roadmap (owner-requested, in priority order)

1. **Commits over time by project** on the All-projects dashboard (Research Addendum 2).
   - Per-project series in fixed categorical order, top N + "Other", legend + direct labels,
     tooltip, and a table alternative.
   - Data: each project's `git.dailyCommits` is already stored per project.
2. **Workspace polish** (follow-ups to Addendum 3):
   - keyboard shortcuts (focus pane N, maximise)
   - drag a session between panes
   - per-pane font size
   - a way to send a finished interactive session's outcome back to the card (e.g. a
     "Mark card for review" action in the pane header)
3. Portfolio status view: stale projects, uncommitted changes, everything in flight across projects.
4. Client tests (Vitest + Testing Library) for the board, dialogs, terminal and workspace.
5. A theme toggle (the tokens already support `data-theme`).

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
- No UI test suite; server tests only (`server/**/*.test.ts`, 50+ tests).
- **Linux:** `node-pty` has no Linux prebuild and compiles from source. Without build tools it's
  skipped (it's optional), and sessions fall back to pipes, where interactive AI CLIs don't work.
- Card IDs (`PM-n`) can be reused after deleting the newest card (no AUTOINCREMENT). Commit refs
  are protected by the card `createdAt` check; agent records by `log_path` identity.
- OpenCode has no read-only mode. Gemini ignores `--approval-mode` in folders it doesn't trust yet.
- `react-hooks/set-state-in-effect`: loaders only set state inside promise callbacks, and
  CardDialog resets its form during render. Keep to these patterns, or lint fails.

## Gotchas

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
