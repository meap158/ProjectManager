# Optional card linking (PM-594)

Both features are off by default. Neither installs a hook nor posts a GitHub comment until requested.

## Warn-only commit hook

From the ProjectManager checkout, run:

```powershell
node scripts/install-card-link-hook.mjs --project "S:\path\to\your-project"
```

The installer writes the checked-in `scripts/templates/commit-msg.cjs` template to that repository's
Git hooks directory as `commit-msg`. This explicit command is the only installation path; the app
does not install it while tracking or scanning projects. Git and Node must be on the committing
process's PATH. The template works in CommonJS and ESM projects, prints a warning if the message
lacks a `Refs PM-n` or `Fixes PM-n` trailer, and exits successfully even if the message is unreadable.
Comment lines do not count as card references. It never changes the message.

The installer requires the repository root and refuses an existing hook, a linked hooks directory,
or configured `core.hooksPath`. For a hook manager, copy the template into its own warn-only workflow
instead. Linked worktrees share the common repository's hooks. To uninstall, remove only the hook
this installer created after checking its contents; do not remove someone else's replacement.

All Git subprocess calls use argument arrays. Installation never changes Git configuration, chains
an unknown hook, bypasses a hook, or downloads code.

## Optional GitHub write-back

Open a project's **Pull requests** tab and select **Comment on linked GitHub issues and PRs when
cards reach Review or Done**. Uncheck it to stop future comments. The equivalent project API is:

```text
GET /api/projects/:id/card-linking
PUT /api/projects/:id/card-linking
Content-Type: application/json
{"writeBack":true}
```

The GET reports the opt-in, whether a scoped Git permission currently authorizes it, and the last
delivery result. Configuration alone is insufficient. An enabled autonomous orchestrator covering
the project must have **Git on its own** enabled. Watch only and paused orchestrators do not authorize
write-back. The feature never enables that setting for you.

Only later status transitions generate work. Existing Review or Done cards are not backfilled.
The card's linked URL must be a GitHub issue or PR in the project's `origin` repository. The selected
GitHub identity and the effective `gh api user` login must both equal the repository owner. Repositories
owned by an organization therefore do not receive comments from a member's personal account.
Cross-repository links never receive comments. Other GitHub hosts are unsupported.

A short comment contains only the card key, Review or Done status and a valid linked commit hash
when available. Card descriptions, local paths, project names and logs are never copied. PRs use
GitHub's issue-comments endpoint, which accepts both issues and PRs.

The outbox lives in ProjectManager's database and covers manual, agent and scanner moves through
the shared card store. It retains at most 200 pending events and processes at most 20 per tick
(every 15 seconds). Rapid transitions for one card coalesce to its latest status. Obsolete, unlinked,
unauthorized or more-than-one-day-old transitions are discarded. Permissions and card state are
checked again after asynchronous identity reads.

Rate limits persist across restarts: one attempt per minute and ten per hour per project, plus one
attempt per card/status per day. A receipt is saved before the external request. A timeout or lost
acknowledgement is not automatically retried; check the linked issue/PR before acting again.
Failures never prevent the card move. Error logs do not include gh output or credentials.

Validation uses fake GitHub calls and temporary repositories. No real repository hook or write-back
setting is enabled during tests, and no test comment is posted to GitHub.
