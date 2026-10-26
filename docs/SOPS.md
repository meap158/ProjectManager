# SOPs (PM-316)

Settings > SOPs lists the standard every project's agent instructions carry and shows, project by
project, which ones it follows. The SOPs and their checks live in `server/sops.ts`; the tab is
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

- `GET /api/sops` runs every check against every project folder, six at a time. Checks only read
  files and run `git ls-files`; they never write inside a project. A full scan of 28 projects takes
  about half a second.
- A **gap** becomes a card: `POST /api/projects/:id/sops/:sopId/card` re-checks the project and adds
  a To do card with what the SOP asks, why, what was found and how to fix it, for an agent to pick up.
- A **waiver** is a recorded, deliberate exception: the project does not follow that SOP and says
  why (ProjectManager's Owner desk data is untracked because the repository is public, for
  example). It is stored in ProjectManager's database (`sop_waivers`), never in the project. A
  waived gap shows as "Waived" with its reason, so the remaining red cells are real.

## Adding an SOP

Add an entry to `SOPS` in `server/sops.ts` with its text (title, short column label, summary, why,
how it is checked, how to fix) and a `check(root)` that returns `pass`, `fail` or `na` with a
one-line detail. Keep checks fast and read-only, add a case to `server/sops.test.ts`, and add the
rule to the shared AGENTS.md text so new projects carry it.
