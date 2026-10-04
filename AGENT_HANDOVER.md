# AGENT_HANDOVER.md

_Current-state snapshot. Update it after every meaningful unit of work._

## State (2026-10-05)

Milestone 1 plus agent dispatch are implemented and verified. Verification covered `npm run check`
(31 tests green), the launcher including port fallback, and a browser check of the dashboard, project
overview and board. The work is committed as the initial commit.

## Product brief

`Research/feature-requests.md` is gitignored and local only. It's the owner's brief plus addenda.
`/References` is empty.

- **Done:**
  - folder tracking
  - code/disk/git stats and charts
  - per-project Kanban
  - commit-ref auto-moves (`PM-12` → In progress, `Fixes PM-12` → Done)
  - cross-project dashboard and project sidebar
  - AI agent runs and sessions
- **Owner wishes not yet built:** a richer portfolio "current state" view (stale/dirty projects,
  everything in flight across projects). The dashboard covers the basics.

## Architecture

See the map in `CLAUDE.md`.

- One Node process serves both the API and the UI on one port. In dev, Vite runs in middleware mode.
- Data lives in SQLite via `node:sqlite` at `data/projectmanager.db`. Agent logs are in
  `data/agent-logs/`.
- **Scans** (`server/scanner.ts`) run in the background and the UI polls every second.
  - `refs_cursor` means a commit only moves a card once, so a card you move back by hand stays put.
  - Line counts use `scc` when it's on PATH; otherwise the built-in counter.
- **Agents** (`server/agents/`):
  - Providers are PATH-probed.
  - The supervisor relaunches wanted sessions and interrupted runs after a restart or reboot.
  - Runs need Accept/Reject validation.
  - Spawning always uses argv arrays, never a shell.
  - See DESIGN.md §12 for the trust model and caps.
- **Rare UI** components are adapted copies in `client/src/components/ui/` (see DESIGN.md §8).
  - Attribution is required: the footer link and the README credit must stay.

## Launcher

- Entry points: `npm run launch`, `launch.bat`, `launch.ps1`, `./launch.sh`.
- Port selection: `PORT` (env or `.env`), else `package.json` `config.port` = 5180.
  - If the port is busy, it tries +1, +2 and so on, up to 50 ports.
  - It also recovers from a port race by watching for the server's `[server] EADDRINUSE` line.
- Verified 2026-10-05: with 5180 occupied, it started on 5181 and printed
  `http://localhost:5181 (preferred port 5180 was busy)`.

## Known issues and tech debt

- Complexity is a heuristic: branch tokens are counted per line, and strings are only skipped
  within a single line.
- No UI test suite. Only server tests exist (`server/**/*.test.ts`).
- Agent run "validated move" choices and providers aren't configurable from the UI beyond what's
  shown.
- `react-hooks/set-state-in-effect`: loaders only set state inside promise callbacks, and
  CardDialog resets its form during render. Keep to these patterns, or lint fails.

## Next steps (suggested)

1. A portfolio status view: stale projects, uncommitted changes (`git status --porcelain`),
   in-flight cards across projects.
2. Client tests (Vitest + Testing Library) for the board and dialogs.
3. A theme toggle (the tokens already support `data-theme`).

## Gotchas

- The `S:` drive is slow: ESLint takes about 70s, `tsc` about 60s and `npm run check` a few minutes.
  Run checks in the background.
- npm installs sometimes fail on the first attempt (network); retrying works.
- `npx shadcn add` added a bogus `cn` dependency once, and Rare UI components may import `next/*`.
  Review the diff after adding any component.
- `node:sqlite` prints an ExperimentalWarning. The launcher suppresses it.
- A dev server from an earlier session may still be holding port 5180. That's fine: the launcher
  just uses the next free port.
