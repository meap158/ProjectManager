# ProjectManager

A local dashboard for all the code projects on your computer. Point it at your project folders and it
shows how big each one is, what it's written in and how active it is, much like a GitHub repo page.
Each project also gets a Trello-style board for planning upcoming features, and cards can be handed to
an AI coding agent.

ProjectManager stores its data locally. GitHub PR queries use your gh login; agent CLIs use their configured providers.

![Dashboard with portfolio totals, languages and project rankings](docs/screenshots/dashboard.png)

## What it does

- **Track project folders.** Add any folder, browsing your drives from the app.
- **Code stats:**
  - lines of code, comments and blank lines
  - complexity estimate, language breakdown
  - file and folder counts, largest files
- **Size on disk:** the whole folder (including `node_modules`, builds, `.git`), source files only, and the
  biggest top-level folders.
- **Git activity:** a GitHub-style commit heatmap, commits per month, contributors, recent commits, and
  first/last commit dates.
- **Portfolio dashboard:** totals across all projects, a ranked table, and **commits by project**
  over the last 12 months, 12 weeks or 30 days, so you can see which projects get the most work.
- **Global Board:** cards across projects, project tags, filters and full card creation. New card uses the same dialog as Edit card, including images and agent/session choices.
- **Project list order:** sort the sidebar by name, activity, code size, terminals or tasks, or
  pick **Custom order** and drag projects by their handle (or focus a handle and use ↑ / ↓).
- **Theme:** System, Light and Dark, remembered across reloads.
- **Phone layout:** at 768px wide and below, a bottom tab bar (Home, Projects, Board, Agents,
  Settings) replaces the top nav, the project list opens full screen, and dialogs become bottom
  sheets. The same layout fits narrow desktop windows.
- **Board or List:** every board has Notion-style view tabs. **Board** is the Kanban; **List**
  groups cards by status in collapsible sections with one row per card, which is easier on a
  phone. Your choice is remembered per browser.
- **Last page:** opening the app returns to the page you had open (project tab, board, or agents). All projects still opens the dashboard when you choose it.
- **Settings** (top right): agent CLIs with one-click install using each vendor's official
  method, and per-project board column presets (Full flow, Simple, Capture flow).
  **Agent permissions**: one level for all agents (the CLIs' own settings, Read-only, Edit files or
  Full access) and, per CLI, "Inherit" or its own level; each level is translated into that CLI's
  own flags/config and applies to terminal sessions on their next start and as the run default.
- **Pull requests:** a project tab lists up to 100 open GitHub PRs, draft/review state, branches and authors. Install GitHub CLI and run `gh auth login`; Refresh reloads the list.
- **Feature board per project:** Backlog → To do → In progress → Review → Done, with drag and drop.
- **Automatic card moves.** Every card has a key like `PM-12`.
  - A commit that mentions `PM-12` moves it to **In progress**.
  - A commit saying `Fixes PM-12` (also `closes` / `resolves` / `completes`) moves it to **Done**.
  - Moves apply automatically within about 15 seconds of the commit (no Refresh needed); a card
    you move back by hand stays put.
- **AI agents:** dispatch a card to Claude Code, Codex, Grok, Antigravity or OpenCode (whichever is
  installed).
  - Choose what the agent may do: **Read-only**, **Edit files** (default) or **Full access**.
  - Dispatching moves the card to In progress.
  - When the run finishes you see what it changed ("3 files changed · 1 commit"), then
    **Accept** (the card moves to Review) or **Reject** (it goes back to To do).
  - **Work on it in a terminal** (on a card) starts an interactive session already given the
    card's task. The card shows a **⌨ live** badge while it runs.
  - **Send to this session** (on a card) gives the task to an agent session that's already running,
    so it keeps everything it already knows about the project.
  - The **Agents** workspace (top bar) shows sessions from any projects side by side: pick a
    layout (1, 2, 3 or 4 panes), double-click a pane header (or Alt+Enter) to maximise it,
    Alt+1…4 to jump between panes, and drag a header to swap panes. Your layout is
    saved and comes back after reloads and restarts.
  - Terminals are real and interactive. Click and type, and full-screen CLIs
    like `claude` work in the browser. Sessions survive restarts and reboots and resume the
    conversation where supported.

![Project overview: stats, commit heatmap, monthly commits and languages](docs/screenshots/project-overview.png)

![Feature board](docs/screenshots/project-board.png)

![Agents workspace: a shell for one project next to a Claude session that took card PM-4, then PM-5, in the same conversation](docs/screenshots/agent-workspace.jpg)

## Requirements

- **Node.js 22.13+**
- **git** on your PATH (for commit stats; everything else works without it)
- Optional: [scc](https://github.com/boyter/scc) on your PATH. If found, it's used for faster, more
  accurate line counts.
- Optional: an AI coding CLI (`claude`, `codex`, `grok`, `agy`, `opencode`) for agent dispatch

## Quick start

```bash
git clone <this repo> ProjectManager
cd ProjectManager
npm install
npm run launch
```

Then open the URL the launcher prints (normally http://localhost:5180). It opens in your browser
automatically.

You can also start it with `launch.bat` / `launch.ps1` on Windows, or `./launch.sh` on macOS/Linux.
If `node_modules` is missing, the launcher runs `npm install` for you.

### Ports

The launcher prefers port **5180**. If that port is already in use, it automatically tries 5181, 5182
and so on, then prints the URL it actually used. You never need to free up a port yourself. To change
the preferred port, set `PORT` in `.env`.

If ProjectManager is already running for the same data folder, the launcher doesn't start a
second copy. It prints the running URL and opens it.

### Configuration (optional)

Copy `.env.example` to `.env` to override any of these:

| Variable   | Default     | Purpose                                                       |
| ---------- | ----------- | ------------------------------------------------------------- |
| `PORT`     | `5180`      | Preferred port (the launcher falls back to the next free one) |
| `HOST`     | `127.0.0.1` | Interface to bind. Keep it local                              |
| `DATA_DIR` | `./data`    | Where the SQLite database is stored                           |
| `BROWSER`  | (unset)     | Set to `none` to stop the browser from opening                |
| `SCC`      | (unset)     | Set to `off` to ignore an installed `scc`                     |

## Using it

1. Click **+ Add** and pick a project folder. The first scan starts right away.
2. Open the project for its **Overview**. Click **Refresh** after you've made changes.
3. Use the **Board** tab to capture upcoming features. Click a card to edit it, change its column, or
   dispatch it to an AI agent.
4. Mention card keys in your commit messages and the board keeps itself up to date.

"Remove" (the bin icon) only stops tracking a project. It never touches your files.

The switch at the top right picks **Match system**, **Light** or **Dark**. It's remembered
per browser.

![Phone layout: dashboard, Projects panel and a board in List view](docs/screenshots/mobile.png)

## Development

| Command          | What it does                                       |
| ---------------- | -------------------------------------------------- |
| `npm run launch` | Dev server with hot reload (same as `npm run dev`) |
| `npm run check`  | Typecheck + lint + format check + tests            |
| `npm run build`  | Production build into `dist/`                      |
| `npm start`      | Run the production build through the launcher      |

Contributors and AI agents: read [CLAUDE.md](CLAUDE.md) for conventions, [DESIGN.md](DESIGN.md) for UI
rules, and [AGENT_HANDOVER.md](AGENT_HANDOVER.md) for the current state.

## Security note

The app can read any folder on your computer and run AI agent CLIs, so it only listens on `127.0.0.1`
and rejects requests from other sites. Don't expose it to a network.

## Credits

Animated components by [Rare UI](https://rareui.com) (MIT + Commons Clause; attribution required).

## LAN access (opt-in)

Settings → **LAN access** opens ProjectManager to other devices on your network (phone, laptop). It
is off by default and runs as a separate listener (the app port + 100); the normal server stays on
`127.0.0.1`. On the device, open the address shown in Settings and type the **4-character code**
shown next to it, like signing in to GitHub on a TV. The code works once, expires after 10 minutes
and is retired after 5 wrong tries, so guessing is hopeless; wrong tries are also rate-limited per
device. Each signed-in device gets its own secure cookie (HttpOnly, SameSite=Strict) and is listed
in Settings, where you can sign it (or all devices) out. Only this computer's own LAN addresses
(and its name) are accepted, and LAN devices can't view or change the LAN settings. Signed-in
devices can read your tracked folders and drive agents, so only sign in devices you trust.
Windows may ask to allow Node.js the first time: allow it on Private networks only.

**On a phone** you get the phone layout (bottom tab bar, Projects panel, List view for boards).
Add it to your home screen (Safari: Share → Add to Home Screen; Chrome: ⋮ → Add to Home screen) to
open it full screen with its own icon; a home-screen app keeps its own sign-in, so type a fresh code
once more there. Folders open only on the computer, so the project path is plain text on the phone.
If a device is signed out in Settings, it lands back on the sign-in page by itself.

If the phone can't load the address: it must be on the same network as the computer (not a guest
Wi-Fi, which usually isolates devices), and Windows Firewall must allow Node.js on that network's
profile (Settings → Network shows whether it is Private or Public). With `npm run launch` (dev
mode) pages load and work, but live reload doesn't reach the phone; reload by hand after changes.

## Agent board tools and images

Claude Code, Codex and OpenCode sessions/runs launched by ProjectManager receive a
`projectmanager` MCP server automatically. It provides `get_card`, `update_status`, `add_note`,
`read_image` and `create_card`. It can access only the owner's currently assigned card in that project;
a session started without a card (directly in a terminal) can call `create_card` once to make one for
its work, which then becomes its card. Agents are told to commit atomically and reference their card
(`Refs PM-12` while working, `Fixes PM-12` when complete), so the board follows their commits.
reattaching changes that scope, detaching removes card access, and deleting the owner revokes it.
Card dialogs show **Agent board history** for audited status changes and notes. Validate work
before moving it to Review; Done means the task is complete.

The stdio bridge (`scripts/board-mcp.mjs`) finds the live local server on each request, including
after port fallback. CLI config is injected per process; project and global CLI files are not edited.
Capabilities are stored in the local database and passed through environment variables, never task text.
Existing terminals started before this integration need a stop/start to load MCP configuration.

Image transport uses documented provider support: Codex initial prompts use `--image`, Claude gets
`--add-dir` access, Antigravity gets `--add-dir`, and OpenCode one-shot runs use `--file`.
MCP `read_image` delivers native image content, including when sending a new card to an existing
connected session. Grok and custom commands retain file-path context: automatic isolated MCP/image
configuration has not been verified for those providers. Clipboard image shortcuts are not emulated.

References: [Codex CLI](https://developers.openai.com/codex/cli/reference),
[Claude CLI](https://code.claude.com/docs/en/cli-reference),
[OpenCode CLI](https://opencode.ai/docs/cli/).
