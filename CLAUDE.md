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

| Path                      | What lives there                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `scripts/launch.mjs`      | One-command launcher: prerequisite checks, free-port search, process-tree cleanup   |
| `server/index.ts`         | HTTP bootstrap. Dev: Vite middleware on the same port. Prod: serves `dist/client`   |
| `server/app.ts`           | Hono API (`/api/*`), validation (zod), security middleware                          |
| `server/store.ts`         | All project/card SQL. Routes never touch the DB directly                            |
| `server/db.ts`            | `node:sqlite` connection + **append-only** migrations (`PRAGMA user_version`)       |
| `server/boardMcp.ts`      | Scoped agent board tools, process config injection and audit records                |
| `scripts/board-mcp.mjs`   | MCP stdio bridge to the live local server                                           |
| `server/pullRequests.ts`  | gh-backed pull requests for a project: list, mergeability, and PR actions           |
| `server/ghAccount.ts`     | Which gh account a project acts as (repo owner's login, via per-call GH_TOKEN)      |
| `server/gitIdentity.ts`   | Per-project commit author + gh account injected into agent env only (PM-186)        |
| `server/preview.ts`       | Built-in browser proxy: read-only, loopback ports only (`docs/BUILT-IN-BROWSER.md`) |
| `server/scanner.ts`       | Background scans; cards auto-move from commits, branches and PRs (no agent)         |
| `server/analysis/*`       | Pure-ish analysis: line counter, languages, file listing, disk walk, git, scc       |
| `server/agents/*`         | AI agent providers, run/session supervisor, agent API routes                        |
| `shared/types.ts`         | Types shared by API and client. Change both sides together                          |
| `client/src/pages/*`      | Route-level views                                                                   |
| `client/src/components/*` | App components. `components/ui/` holds Rare UI (shadcn registry) copies             |
| `client/src/styles.css`   | Design tokens + component CSS (see DESIGN.md)                                       |

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
  (`server/lan.ts`): a separate listener (the app's port on this machine's LAN addresses, or app
  port + 100 as a fallback), off by default, devices sign in with a single-use expiring
  code (retired after 5 wrong tries) and then carry their own hashed device token, this machine's
  own LAN addresses only as Host, rate-limited sign-ins, and LAN settings refused from LAN clients. Never weaken that gate or bind the main server wider.
  The one other exception is the opt-in **remote listener** (`server/remote.ts`,
  `docs/REMOTE-ACCESS.md`): loopback only, reached through the owner's own Cloudflare Tunnel, and
  every request needs the exact public Host, a valid Cloudflare Access token (`server/cfAccess.ts`),
  an allowlisted email and an authenticator-code session (`server/totp.ts`). Remote settings and
  secrets are answered on this computer only. Never weaken any of the four checks or let that
  listener bind anything but 127.0.0.1.
- **Preview proxy (`server/preview.ts`):** GET/HEAD only, `127.0.0.1` targets only, never this app's
  own ports, no cookies either way, and the client shows it in a sandboxed iframe **without**
  `allow-same-origin`. Never open `/api/preview/*` as a top-level page: it would run as this origin.
- **Never modify or delete files inside tracked projects** from ProjectManager itself. Only agent runs
  the user explicitly starts may change project files. The one other exception is a pull request
  action the user confirms in the Pull requests tab: it may delete the PR's _local_ branch, and only
  when that branch is not checked out and points exactly at the PR head. Never use gh's own
  `--delete-branch` (it switches the project's checkout).
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
- The server listens on both loopbacks (127.0.0.1 and ::1), and a port counts as free only if
  neither answers. Browsers and Node try `localhost` as ::1 first, and Windows lets another app
  (e.g. a Next.js dev server on 0.0.0.0/::) share our port, so `localhost` would reach that app.
  Local helper scripts call `127.0.0.1` directly.
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

- PM-171: `server/agents/providerTranscripts.ts` adapts pinned OpenCode SQLite and Grok JSONL conversations to shared chat items. Reads are read-only and scoped to both conversation ID and working directory; never infer the latest conversation. OpenCode snapshots capture in-place changes, Grok snapshots coalesce text chunks. `next` is a content revision for these providers, not a byte offset; changed snapshots set `reset`.

## Local notes, human tasks and launcher titles

- `AGENT_HANDOVER.md` is local only and git-ignored. Never stage or commit it; if it is ever tracked, untrack it without deleting the file. Update it after meaningful work so the next agent can resume.
- `References/DEV_TASKS.html` (local, git-ignored) tracks work only a person can do: accounts, credentials, approvals, real-device checks and decisions. Do the work yourself first. Add or update a task only when a human really has to act, with exact steps and what you can continue with meanwhile. Mark a task Completed only with evidence or the owner's confirmation. Never put secrets in it. It is view-only: statuses are edited in the file, so never imply a browser change was saved.
- Launcher windows carry descriptive titles that name the project and the service (for example `ProjectName - Frontend`). Keep the titles, the single obvious launch command and the automatic port fallback working when you change startup.
