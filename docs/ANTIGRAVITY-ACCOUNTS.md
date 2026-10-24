# Antigravity account switching reference

Reviewed 2026-10-24: [agy-auth](https://github.com/fikrilal/agy-auth) is applicable as an optional
adapter for ProjectManager's Antigravity account UI. It is unofficial. ProjectManager now has an
optional adapter and Settings drawer; no tool was installed or live credential switched during validation.

## Integration contract

- Correct npm package: `@fikrilal/agy-auth`; executable: `agy-auth`. The unscoped package is unrelated.
- Prefer subprocess calls with argument arrays and bounded time/output; never parse interactive tables.
- `list --json --no-sync --no-usage` can provide account inventory without quota lookup or live sync.
  For refreshed quota, inspect the documented `list --json` and `usage --all --json` responses.
- Require `schema_version: 1`, the expected command and valid data; handle structured error codes.
  Return only allowlisted account metadata and normalized quota to the browser, never raw output.
- Use exact stable account IDs for `switch <id> --json`, not row numbers, ambiguous aliases or email
  substring queries. A global credential switch affects future launches across projects.
- Disable incidental update checks with `AGY_AUTH_NO_UPDATE_CHECK=1`. Do not run interactive live
  mode alongside ProjectManager's polling or auto-switch logic.
- Quota percentages are **remaining**, whereas ProjectManager meters show usage. Convert with
  `100 - remaining_percent`; preserve reset times, stale/error status and named quota groups.
  A failed quota lookup is unavailable usage, never zero usage.

## Credential and session behavior

The tool writes both the OS keyring and Antigravity's file mirror. Let the adapter own that operation;
do not imitate it by copying only one credential file. Its saved account snapshots are encrypted,
with a separate encryption key. ProjectManager should not decrypt snapshots or export credentials.

Running `agy` sessions retain their old credentials in memory. Switching requires a deliberate
restart/resume path for affected Antigravity sessions. ProjectManager already supports Antigravity
conversation pinning and resume, but cross-account continuation must be verified with a disposable
conversation before offering a global switch-and-continue control. Report partial restart failures
and retain the selected account identity; do not silently start fresh conversations.

Login needs an owner-completed Google OAuth flow. Avoid copying the tool's OAuth client discovery
or treating background account inventory as authorization to log in or activate an account.

## Current gaps and next implementation

ProjectManager has an Antigravity provider, transcript support and continuation controls. Settings now
offers an Antigravity account drawer with missing-tool guidance, metadata, explicit usage refresh and
confirmed stable-ID switching for new launches. `agy-auth` was not found on PATH during this review.
An end-to-end switch cannot be validated here yet. Running sessions are not automatically restarted.

The adapter uses bounded shell-free commands and validates versioned JSON. Fixture/component tests
cover metadata allowlisting, remaining-to-used conversion and explicit switch confirmation.
Add automatic rotation only after named quota
groups and restart/resume semantics have been validated. Keep installation explicit and optional.

Sources: [README](https://github.com/fikrilal/agy-auth#readme),
[user guide and JSON schema example](https://github.com/fikrilal/agy-auth/blob/main/docs/user-guide.md).
