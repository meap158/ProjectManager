# CLAUDE.md: SOPs for AI coding agents

ProjectManager is a local-first web app for tracking project folders: code stats, commit heatmaps,
a per-project Kanban board, and AI agent runs dispatched from cards. Read this file before changing
anything.

## Before you change anything

1. Read `AGENT_HANDOVER.md` (current state, open tasks, gotchas), plus `DESIGN.md` for any UI work.
2. If the change touches a researched decision, look at `/Research` and `/References`. They're
   gitignored and local only. `Research/feature-requests.md` is the owner's product brief.
3. Read the code you'll touch and the conventions around it. Extend existing patterns rather than
   adding competing ones.
4. Work out the smallest coherent change. Don't do unrelated refactors or drive-by reformatting.

## Architecture map

| Path                      | What lives there                                                                  |
| ------------------------- | --------------------------------------------------------------------------------- |
| `scripts/launch.mjs`      | One-command launcher: prerequisite checks, free-port search, process-tree cleanup |
| `server/index.ts`         | HTTP bootstrap. Dev: Vite middleware on the same port. Prod: serves `dist/client` |
| `server/app.ts`           | Hono API (`/api/*`), validation (zod), security middleware                        |
| `server/store.ts`         | All project/card SQL. Routes never touch the DB directly                          |
| `server/db.ts`            | `node:sqlite` connection + **append-only** migrations (`PRAGMA user_version`)     |
| `server/boardMcp.ts`      | Scoped agent board tools, process config injection and audit records              |
| `scripts/board-mcp.mjs`   | MCP stdio bridge to the live local server                                         |
| `server/pullRequests.ts`  | gh-backed open pull requests for a project                                        |
| `server/scanner.ts`       | Background scan jobs (code + disk + git) and auto-moving cards from commit refs   |
| `server/analysis/*`       | Pure-ish analysis: line counter, languages, file listing, disk walk, git, scc     |
| `server/agents/*`         | AI agent providers, run/session supervisor, agent API routes                      |
| `shared/types.ts`         | Types shared by API and client. Change both sides together                        |
| `client/src/pages/*`      | Route-level views                                                                 |
| `client/src/components/*` | App components. `components/ui/` holds Rare UI (shadcn registry) copies           |
| `client/src/styles.css`   | Design tokens + component CSS (see DESIGN.md)                                     |

## Conventions

- **TypeScript strict** everywhere. The server uses NodeNext ESM, so relative imports end in `.js`.
  The client uses the bundler resolution and `@/` points to `client/src`.
- **No new dependencies** without a clear reason; record the reason in the handover. Don't use native
  modules (Windows users must not need build tools). Prefer the Node stdlib.
- **Run external commands with `execFile`/`spawn` and argument arrays.** Never build a shell string
  out of user or repo data.
- **Security model:** the server binds `127.0.0.1`, only accepts allowlisted `Host` headers, and
  requires `Content-Type: application/json` on writes. Keep all three. It can read any folder and run
  agent CLIs, so it must never be exposed to the network, except through the **opt-in LAN listener**
  (`server/lan.ts`): a separate port, off by default, devices sign in with a single-use expiring
  code (retired after 5 wrong tries) and then carry their own hashed device token, this machine's
  own LAN addresses only as Host, rate-limited sign-ins, and LAN settings refused from LAN clients. Never weaken that gate or bind the main server wider.
- **Never modify or delete files inside tracked projects** from ProjectManager itself. Only agent runs
  the user explicitly starts may change project files.
- **DB changes** go in a new migration appended to `MIGRATIONS` in `server/db.ts`. Never edit a
  migration that has shipped: real databases have already run the old text (this happened once, and
  `repairSchema()` exists to clean up after it).
- **UI:** follow `DESIGN.md`. Use token variables, not raw hex. Every drag interaction needs a
  keyboard alternative. Use `ConfirmDelete` for destructive actions, never `window.confirm`.
- **Rare UI attribution** (licence requirement): keep the README credit (a visible link to rareui.com).
- Errors: API errors are `{ error: string }` with a fitting status code. The UI shows them in
  `.error-banner`. Log unexpected server errors with a `[area]` prefix.

## Launching

- `npm run launch`. This is the one obvious entry point. It also runs from `launch.bat`, `launch.ps1`
  and `./launch.sh`.
- The preferred port comes from `PORT` in the environment or `.env`, falling back to
  `package.json` → `config.port` (5180). If that port is busy, the launcher tries the next ports and
  prints the actual URL. The server prints `[server] EADDRINUSE` on a port race, and the launcher
  relies on that line, so keep it.
- Don't break the launcher or the automatic port selection. If you change startup, re-verify both.

## Verification (Definition of Done)

1. `npm run check`: typecheck (client + server), ESLint, Prettier check, Vitest (server tests in
   Node; client component tests on jsdom via `// @vitest-environment jsdom` at the top of the file).
2. `npm run launch`: the app starts, the printed URL works, and the UI flow you changed works in the
   browser.
3. If startup changed: occupy the preferred port (e.g. `node -e "require('net').createServer().listen(5180,'127.0.0.1')"`)
   and confirm the launcher falls back to the next port.
4. Update docs whenever behaviour, architecture, setup or design changes: README (and screenshots
   when the UI changes visibly), DESIGN.md, and this file. Important knowledge must live in the
   repo, never only in chat.
5. Update `AGENT_HANDOVER.md` after every meaningful unit of work. Keep it a current-state snapshot,
   not a diary.
6. Review `git status` / `git diff --cached`. No `data/`, `.env`, `dist/`, `Research/`,
   `References/`, logs or temp files.
7. **Commit atomically**, one coherent change per commit, with a descriptive message (what changed
   and why). Reference the board card it serves: `Refs PM-12` while working, `Fixes PM-12` when
   it's complete (the commit watcher moves the card within ~15s). No card for the work yet? Create
   one on the board (or via the `create_card` MCP tool) first. Leave the repo resumable.

## Gotchas

- The `S:` drive is slow: ESLint takes about 70s and `tsc` about 60s. Run long checks in the background.
- `npx shadcn add` may inject stray dependencies or `next/*` imports. Review its diff.
- `node:sqlite` is "experimental" in Node 22. Its warning is suppressed in the launcher, not removed.
