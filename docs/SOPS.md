# SOPs (PM-316)

Settings > SOPs lists the standard every project's agent instructions carry and shows, project by
project, which ones it follows. The SOPs are data: `server/sops.default.yml` ships with the app, and an edited copy in
`data/sops.yml` replaces it. The engine is `server/sops.ts`; the tab is
`client/src/components/SopsPanel.tsx`.

## The SOPs, in order

The order puts what keeps work safe and resumable first, then planning, then the quality of what
ships.

1. **Agent instructions**: AGENTS.md is canonical, CLAUDE.md points to it.
2. **No secrets in git**: no tracked `.env` (examples excepted), SQLite database or private key.
3. **Agent handover**: AGENT_HANDOVER.md exists and is not tracked.
4. **Roadmap**: ROADMAP.md exists.
5. **Owner pages**: `References/owner-pages/owner-desk.json` exists.
6. **Writing style**: the agent instructions carry the PM-314 rule (blader/humanizer patterns).
7. **One-command launcher**: a root script (launch.bat, start.cmd and the like) sets a window
   title. Does not apply when nothing runs (no app manifest).
8. **Design system**: DESIGN.md exists. Does not apply when no user interface is found.

## How it works

- `GET /api/sops` runs every enabled SOP against every project folder, six at a time. A full scan
  of 28 projects takes about half a second.
- Checks come from a fixed vocabulary: `file_exists`, `file_missing`, `untracked` (nothing matching
  is tracked by git), `file_contains` and `root_files` (a root-level file, optionally containing a
  pattern), plus `applies_when` (`runnable`, `has_ui`, or a file). There is no "run a command"
  kind, so an edited file can only read files and ask `git ls-files`; it never writes inside a
  project or runs its code. Paths must stay inside the project, regexes are length-capped and
  compiled on save, and a file read stops at 1 MB.
- Clicking a cell opens its details in a modal: what was found, what the SOP asks, how it is
  checked and how to fix it. For a **gap**, **Create card...** re-checks the project
  (`GET /api/projects/:id/sops/:sopId/draft`) and opens the board's own new-card dialog with the
  project chosen and the title and notes filled in, so the card can be edited and handed to an
  agent there like any other. **Send to session...** and **Waive...** sit in the same modal.
- A **waiver** is a recorded, deliberate exception: the project does not follow that SOP and says
  why (ProjectManager's Owner desk data is untracked because the repository is public, for
  example). It is stored in ProjectManager's database (`sop_waivers`), never in the project, and
  only the owner sets one from the tab. Waivers whose SOP left the file are kept and listed.

## Editing the SOPs

**Edit SOPs** opens the file as YAML. The comments at its top list every check kind. Saving
validates first and refuses a file with a problem, naming its line and column; a valid file is
saved to `data/sops.yml` (local, not in git) and used from the next check. **Reset to defaults**
removes that copy. A copy broken by hand outside the app is ignored: the defaults run and the tab
says what is wrong. Saving and resetting answer on this computer only (LAN and remote get 403);
reading is open, like the rest of the tab. Keep ids stable, since waivers are stored by id, and
set `enabled: false` to hide an SOP without deleting it.

## Audits by agents

- **Sessions** get `sop_check` among their board tools: this project's results, with how to fix
  each gap. It needs no card.
- **Orchestrator chats** get `sop_report` (their scope, or one project in it) and `sop_card` (a card
  for one gap, from a fresh check, in a project in scope). Both refuse projects outside the scope.
- No agent can waive. The tool descriptions say so, and ask the agent to suggest a waiver with a
  reason in its reply instead.
- In the tab, **Audit with...** sends a full audit to an orchestrator chat, and a gap's **Send to
  session...** offers that project's running sessions and every orchestrator chat whose scope
  includes it (`GET /api/sops/sessions`). The message names the audit tool, so the agent acts on a
  fresh check rather than on what the page showed.

## Adding an SOP

Add an entry in Edit SOPs (or to `server/sops.default.yml` for everyone) with its text and checks.
For a check the vocabulary cannot express, add a kind to the schema and `runCheck` in
`server/sops.ts`, keeping it read-only, with a case in `server/sops.test.ts`. Then add the rule to
the shared AGENTS.md text so new projects carry it.
