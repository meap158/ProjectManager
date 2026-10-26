# Roadmap

Last updated 2026-10-25. This is the plan and where it stands. Day-to-day work lives on the board
(`PM-n` cards); what is built is in the [README](README.md); how it works is in
[CLAUDE.md](CLAUDE.md) and [DESIGN.md](DESIGN.md).

## Vision

A local-first workspace for running AI coding agents across all your projects, with a board that
keeps itself up to date. Add project folders, see what is in them, start agent CLIs in real
terminals, tie them to cards, and watch commits and pull requests move the cards. Your projects and
data stay on your computer, and it works from a phone too.

## Scope

**In scope**

- Tracking project folders: code stats, languages, size, commit heatmaps, pull requests.
- A per-project Kanban board and an all-projects board, with cards that move from commits, branches
  and pull requests.
- Persistent agent sessions in real terminals (Claude Code, Codex, Grok, Antigravity, OpenCode),
  card-linked runs, and orchestrator chats that work across projects.
- Switching between accounts of the same agent and reading each one's usage.
- Reaching the app from a phone: over the LAN, and from anywhere through the owner's own Cloudflare
  Tunnel.
- A built-in browser (Preview) for the apps running on this computer.

**Out of scope**

- A code editor or IDE, a CI system, or a hosted multi-user service. There is no account, cloud copy
  or telemetry.
- Changing files in tracked projects from the app itself. Only agent runs the owner starts do that,
  with two narrow exceptions, both on this computer only and both recorded in CLAUDE.md: a confirmed
  pull-request action may delete the PR's local branch, and the Files tab's menu may rename one entry.
- Exposing the server beyond loopback except through the two opt-in listeners (LAN, remote), each
  with its own gate.

## Phases

| Phase                     | Delivers                                                                                                                                                                                  | Exit criteria                                                                                                                         | Status                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1. Portfolio and insights | Tracked folders, lines of code and languages, disk usage, commit heatmaps, all-projects totals                                                                                            | A project added from a folder shows its stats and heatmap; removing it never touches the folder                                       | Done                                                                                                                 |
| 2. Board and automation   | Kanban per project and global; cards move from commits, branches and pull requests                                                                                                        | A commit saying `Fixes PM-n` moves the card within seconds; every move leaves a note                                                  | Done                                                                                                                 |
| 3. Agent workspace        | Real-terminal sessions that survive restarts, card-linked runs, chat view, Files and PR tabs                                                                                              | A session survives a browser close and a server restart and resumes its conversation where the CLI allows                             | Done                                                                                                                 |
| 4. Orchestrators          | Chat and scheduled workers across projects, scoped board tools, audit trail                                                                                                               | An orchestrator only acts inside its projects, within its worker limits, and every action is recorded                                 | Done (ongoing tuning)                                                                                                |
| 5. Accounts and usage     | Account switching and live usage for Codex, Claude, Antigravity and Grok                                                                                                                  | A switch keeps the conversation and never exposes another account's credentials                                                       | Built; Grok (PM-254) awaiting owner                                                                                  |
| 6. Anywhere access        | Phone layout, LAN sign-in, remote access through a Cloudflare Tunnel with Access                                                                                                          | The owner signs in from a phone on the LAN and through the tunnel, and each of the four remote checks holds                           | Built (tunnel may point at the main port); real tunnel and phone not yet checked (owner desk DT-002, DT-004, DT-005) |
| 7. Built-in browser       | Preview page: running local apps, tabs, own-origin mode with live reload, app actions                                                                                                     | An app started in a project opens in a tab with live reload; over LAN or remote it is a read-only view                                | Built; phone check pending (PM-253)                                                                                  |
| 8. Quieter attention      | Inbox bell for sessions that need a decision, failed, hit a limit or finished                                                                                                             | Every session waiting on the owner shows in one place and can be answered without opening it                                          | Built (PM-261)                                                                                                       |
| 9. More agent options     | Other OpenCode models, Cline                                                                                                                                                              | Chosen options run in a session with the same persistence and account handling as the others                                          | Not started (PM-212, in the backlog)                                                                                 |
| 10. Files explorer        | File-type icons and keyboard tree, pins, a folder previewer (grid or list, filters, new-or-changed badges, picture sizes, git marks) with an image lightbox, links inside previewed pages | Picking a folder or file in the tree or a pin shows it without the page jumping; filters stay per folder; every write stays host-only | Built (PM-282, PM-284, PM-286, PM-287); phone check pending                                                          |

## Dependencies

- **Node.js 22.13 or newer** and its experimental `node:sqlite`. The launcher suppresses the
  warning; a Node change to it would need a migration of the storage layer.
- **The agent CLIs** and their own sign-ins. ProjectManager launches them and reads their local
  files; it does not ship them.
- **GitHub CLI** (`gh`) for pull requests; **Cloudflare** (a tunnel and an Access application) for
  remote access, set up by the owner.
- **A real phone** for acceptance of anything that feels different on touch.

## Risks

| Risk                                                                        | Why it matters                                                          | What limits it                                                                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Agent CLIs change their files or output between versions                    | Account switching, usage and chat reading depend on them                | Adapters read only what they must, are covered by tests, and fall back to the terminal               |
| Several sessions edit one working tree at once                              | Commits can sweep another session's work                                | Each session stages only its own hunks; the repository rules say so (CLAUDE.md)                      |
| The app can read any folder and run agent CLIs                              | A weakened gate would expose the computer                               | Loopback only, allowlisted hosts, JSON-only writes; LAN and remote gates are never loosened          |
| The repository is public                                                    | Local data, accounts and screenshots must not leak                      | `data`, `Research`, `References` and the handover are git-ignored; screenshots use demo data only    |
| Process tests are sensitive to machine load                                 | A busy machine makes lifecycle tests time out and hides real failures   | Rerun in isolation before treating a failure as real; the suite is not claimed green when it was not |
| Windows specifics (slow `S:` drive, `C:` nearly full, process-tree cleanup) | Long checks and temp files can fail for reasons unrelated to the change | Long checks run in the background; temporary files go to the scratch folder                          |

## Owner actions

Everything only the owner can do is on the **Owner desk** (`npm run owner:pages`, then open
`References/owner-pages/index.html`): the Cloudflare setup, and real-phone checks of the CLI, chat,
Preview, Files menu and Inbox.

PM-305 refines existing Codex rotation: fresh exhaustion, 5-hour/weekly/saved-order ranking,
and global safe idle checks preserve grace work. Browser and live-account acceptance remain pending.
