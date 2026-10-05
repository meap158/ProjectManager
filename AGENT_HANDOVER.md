# AGENT_HANDOVER.md

_Current-state snapshot. Update it after every meaningful unit of work._

## State (2026-10-05)

Milestone 1 and the agent CLI integration are implemented and verified.

- **First commit:** milestone 1 plus the original agent dispatch.
- **Second unit (this one):** made the CLI integration actually work. Verified end to end on Windows:
  - a real Claude dispatch edited a file and recorded the change as evidence
  - Codex and Gemini now launch (they failed only on account limits and auth)
  - interactive Claude runs in the browser terminal, with conversation resume after a server crash

## Product brief

`Research/feature-requests.md` is gitignored and local only. It's the owner's brief plus addenda;
read it before product work. `/References` is empty.

- **Done:**
  - folder tracking
  - code/disk/git stats and charts
  - per-project Kanban and commit-ref auto-moves
  - cross-project dashboard and project sidebar
  - agent runs (dispatch from card → validate) and persistent PTY sessions

## Roadmap (owner-requested, in priority order)

1. **Agent workspace: multi-pane, dead simple, wired to the board** (Research Addendum 3).
   - Goal: one workspace view with splittable panes. Show several sessions for one project, or
     sessions across several projects at once.
   - Layout persists across reloads and restarts (store it server-side).
   - Minimal chrome to save screen space: collapsible pane headers, maximise a pane, keyboard
     shortcuts.
   - From a Kanban card: "open in pane" / dispatch straight into a pane. The card shows its live
     session, and results flow back to the card.
   - Efficiency: one SSE stream per visible pane, none for hidden ones; xterm instances only
     for visible panes.
   - Building blocks already exist: `TerminalView` (interactive SSE + PTY), supervisor sessions,
     `GooeyNav`-style tabs.
2. **Commits over time by project** on the All-projects dashboard (Research Addendum 2).
   - Per-project series in fixed categorical order, top N + "Other", legend + direct labels,
     tooltip, and a table alternative.
   - Data: each project's `git.dailyCommits` is already stored per project.
3. Portfolio status view: stale projects, uncommitted changes, everything in flight across projects.
4. Client tests (Vitest + Testing Library) for the board, dialogs and terminal.
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
- Migrations are append-only in `server/db.ts`. Migration 3 added `agent_runs.autonomy`,
  `agent_runs.changes_json` and `agent_sessions.terminal`.

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
