# AGENTS.md: SOPs for AI coding agents

> **Canonical agent instructions.** This file is the single source of operating rules for every AI coding agent (Codex, Claude Code, Gemini CLI, Cursor and others). `CLAUDE.md` is only a pointer to it.

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

| Path                           | What lives there                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `scripts/launch.mjs`           | One-command launcher: prerequisite checks, free-port search, process-tree cleanup          |
| `server/index.ts`              | HTTP bootstrap. Dev: Vite middleware on the same port. Prod: serves `dist/client`          |
| `server/app.ts`                | Hono API (`/api/*`), validation (zod), security middleware                                 |
| `server/store.ts`              | All project/card SQL. Routes never touch the DB directly                                   |
| `server/db.ts`                 | `node:sqlite` connection + **append-only** migrations (`PRAGMA user_version`)              |
| `server/boardMcp.ts`           | Scoped agent board tools, process config injection and audit records                       |
| `scripts/board-mcp.mjs`        | MCP stdio bridge to the live local server                                                  |
| `server/pullRequests.ts`       | gh-backed pull requests for a project: list, mergeability, and PR actions                  |
| `server/ghAccount.ts`          | Which gh account a project acts as (repo owner's login, via per-call GH_TOKEN)             |
| `server/gitIdentity.ts`        | Per-project commit author + gh account injected into agent env only (PM-186)               |
| `server/projectFileActions.ts` | Files tab context menu: rename in place, open/reveal on the host (PM-259)                  |
| `scripts/owner-pages.mjs`      | Owner Pages generator: Owner desk and index from `owner-desk.json` (PM-258)                |
- **Owner pages and roadmap audit (PM-289):** the Owner Pages index links `ROADMAP.md`, and the generator fails (build and `--check`) when the project has no `ROADMAP.md`. Whenever you change the project's state (a phase starts or ends, scope changes, a task only the owner can do appears or is completed), update `ROADMAP.md` and `owner-desk.json` in the same unit of work so both match reality, rebuild the pages, and match the project's own design (tokens and DESIGN.md where it has one). Do not leave a draft roadmap unmarked: say "Draft" until the owner has confirmed it.
| `server/sops.ts`               | SOP engine: YAML SOPs (`sops.default.yml`, data/sops.yml), read-only checks (`docs/SOPS.md`) |
| `server/preview.ts`            | Built-in browser proxy: read-only, loopback ports only (`docs/BUILT-IN-BROWSER.md`)        |
| `server/jsonEtag.ts`           | ETag + 304 for JSON GETs, so polls of unchanged lists cost no body (`docs/PERFORMANCE.md`) |
| `scripts/benchmark-app.mjs`    | `npm run bench`: bundle size and API latency, read-only (`docs/PERFORMANCE.md`)            |
| `server/scanner.ts`            | Background scans; cards auto-move from commits, branches and PRs (no agent)                |
| `server/analysis/*`            | Pure-ish analysis: line counter, languages, file listing, disk walk, git, scc              |
| `server/agents/*`              | AI agent providers, run/session supervisor, agent API routes                               |
| `shared/types.ts`              | Types shared by API and client. Change both sides together                                 |
| `client/src/pages/*`           | Route-level views                                                                          |
| `client/src/components/*`      | App components. `components/ui/` holds Rare UI (shadcn registry) copies                    |
| `client/src/styles.css`        | Design tokens + component CSS (see DESIGN.md)                                              |

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
  secrets are answered on this computer only. The main loopback listener also hands the exact public
  hostname to the same gate (`remote.owns` / `remote.serve` in `index.ts`) and refuses any other
  request carrying Cloudflare headers (`viaCloudflare`), so a tunnel may point at the app's own
  port; keep both, and never route that hostname to the local handler. Never weaken any of the four checks or let that
  listener bind anything but 127.0.0.1.
- **Preview proxies (`server/preview.ts`, `server/previewHost.ts`):** `127.0.0.1` targets only, never this
  app's own ports, no redirects off the app. Path mode (`/api/preview/<port>/`, used over LAN and
  remote) is GET/HEAD only and shown in a sandbox **without** `allow-same-origin`; never open it as a
  top-level page (it would run as this origin). Own-origin mode (`p<port>.localhost`) is routed ONLY
  by the loopback listener in `index.ts`, never by the LAN or remote gates, so keep those calling
  `handle` directly. Never accept a preview WebSocket from another website's origin. Both modes add
  one script to HTML pages, the element picker (`server/previewPicker.ts`, PM-311): inert until the
  framing app sends "start", never in nested frames, reporting only to `window.parent`; the app
  accepts its messages only from the shown frame while picking and treats them as untrusted (parsed,
  capped, shown as text). It must stay read-only: it never sends requests or changes the page.
- **Never modify or delete files inside tracked projects** from ProjectManager itself. Only agent runs
  the user explicitly starts may change project files. The one other exception is a pull request
  action the user confirms in the Pull requests tab: it may delete the PR's _local_ branch, and only
  when that branch is not checked out and points exactly at the PR head. Never use gh's own
  `--delete-branch` (it switches the project's checkout). The third exception (PM-259) is the Files
  tab's context menu (`server/projectFileActions.ts`): **rename one entry in its own folder** (a
  single plain name, never overwriting, never `.git`, never through a link out of the project, the
  project root excluded) and **open or reveal** an entry on the host (argument arrays only; files the
  system would run, like .bat or .exe, are never opened). Both answer on this computer only: the LAN
  and remote listeners get 403. The one exception is **Run in terminal** for a Windows .bat/.cmd
  launcher, which also answers the remote listener (the owner's decision: that session is signed in
  through Cloudflare Access and an authenticator code, and can already run commands in its agent
  terminals); never a LAN device, whose requests are stripped of the remote marker. Keep every one
  of those checks. Preview's **Stop process** (PM-270,
  `stopLocalApp` in `server/localPorts.ts`) ends a program listening on a listed loopback port: only
  the pid a fresh detection still sees on that port, never this server or its launcher, this app's
  ports or system services, after the user confirms, and on this computer only (LAN and remote get
  403).
- **DB changes** go in a new migration appended to `MIGRATIONS` in `server/db.ts`. Never edit a
  migration that has shipped: real databases have already run the old text (this happened once, and
  `repairSchema()` exists to clean up after it).
- **UI:** follow `DESIGN.md`. Use token variables, not raw hex. Every drag interaction needs a
  keyboard alternative. Use `ConfirmDelete` for destructive actions, never `window.confirm`.
- **Rare UI attribution** (licence requirement): keep the README credit (a visible link to rareui.com).
- **Writing style (PM-314):** write prose, UI text, docs and commit messages like a person writing for
  one reader. No em dashes (use a period, comma, colon or parentheses), no stock openers or closers,
  no overused words, no contrast framing that argues with nobody, no chatbot residue, no emoji in
  headings. The full pattern list is [blader/humanizer](https://github.com/blader/humanizer); it
  edits prose only, never code, data or link targets. `npm run prose:audit` counts the
  pattern-detectable tells in a project's markdown and text, and `npm run prose:audit -- --diff`
  fails on any added line that has one. Run the `--diff` form before every commit. Existing text is
  not a failure; fix it when you touch it.
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
- **Owner Pages** (`npm run owner:pages`, local, git-ignored, in `References/owner-pages/`) are what the owner reads. The **Owner desk** lists work only a person can do: accounts, credentials, approvals, real-device checks and decisions. Its data is `References/owner-pages/owner-desk.json` (statuses, steps, evidence) and the tracked generator is `scripts/owner-pages.mjs`; edit the JSON, then rebuild, and never edit the generated HTML. The generator also writes the tasks into the page as plain HTML (`scripts/owner-pages-static.mjs`), so a viewer that does not run scripts (a preview pane, a sandboxed frame) still shows them; keep that call when you change the generator. Do the work yourself first. Add or update a task only when a human really has to act, with exact steps and what you can continue with meanwhile. Mark a task Completed only with evidence or the owner's confirmation (the generator refuses a Completed task without `evidence`). Never put secrets in it. Statuses live in the JSON, so never imply a browser change was saved (the owner's ticks on the page are their own marker, kept in their browser). `References/DEV_TASKS.html` is retired: its six tasks moved to the Owner desk unchanged on 2026-10-25.
- **Deviation from the shared standard:** the desk's data is not tracked. This repository is public, and the desk names the owner's own accounts, devices and infrastructure steps, so only the generator, its schema and its tests are in git. QA scorecard and Feature parity pages are not built: they grade offerings based on existing products, and ProjectManager has none.
- `ROADMAP.md` (tracked, project root) holds the vision, scope boundaries, phases with exit criteria, dependencies and risks. Update it when a phase changes status or the scope changes, and never invent scope the owner has not committed to.
- Launcher windows carry descriptive titles that name the project and the service: `launch.bat`, `launch.ps1` and `launch.sh` set `ProjectManager - Server`, and `scripts/launch.mjs` adds the port it chose (`ProjectManager - Server :5181`) when stdout is a terminal. Keep the titles, the single obvious launch command and the automatic port fallback working when you change startup.

- PM-305: preserve fresh identity-bound exhaustion, 5-hour/weekly/saved-order ranking and the global
  idle/input/run guard for Codex rotation. Recheck stop/delete and selection after asynchronous usage
  reads. Only limit-blocked work receives Continue. See `docs/ACCOUNT-SWITCHER-AUDIT.md`.

- PM-306: Home includes `/` and `/projects/:id`. Keep the persistent Home selection separate from
  last-page startup restoration; the temporary launcher `/` must not overwrite it. See `homeSelection.test.tsx`.
