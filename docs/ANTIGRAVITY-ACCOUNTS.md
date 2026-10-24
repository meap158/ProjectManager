# Native Antigravity accounts

ProjectManager manages Antigravity account profiles directly on Windows. No agy-auth executable
or npm installation is required. Settings > Agent CLIs > Antigravity > Accounts offers Save current
CLI login, Import credential file, Refresh usage and confirmed switching for future launches.
The drawer follows the Codex account UI: automatically detected Default email/active state,
saved rows, usage meters, individual refresh, nickname/remove actions and drag-reorder mode.
Default detection does not save a profile. Removing a saved row does not sign out the current CLI.

The Windows bridge reads/writes generic Credential Manager target gemini:antigravity using UTF-8
blobs. Windows Credential Manager is authoritative; the CLI fallback file at
~/.gemini/antigravity-cli/antigravity-oauth-token is mirrored on a successful switch. Both stores
must verify successfully. The previous login is retained; failed changes attempt rollback.

Saved profiles are AES-256-GCM encrypted beneath data/antigravity-accounts. Back up that directory
including encryption.key; losing the key makes saved profiles unrecoverable. No token reaches the
browser, logs or subprocess command arguments. Credential import is local JSON, limited to 64 KiB.
Importing a profile does not activate it. Existing agy-auth encrypted profiles are not imported
implicitly; export/import is a separate owner action.

Quota is read natively from the Code Assist account endpoints using each saved account's own
unexpired access token. Missing or expired tokens and network failures yield unavailable quota,
never another account's cached numbers. This version does not discover OAuth clients or refresh
expired access tokens: sign in with Antigravity, then save the refreshed CLI login. It supports
manual switching; automatic rotation and cross-account resume remain unverified and disabled.
Running sessions retain their in-memory credentials until restarted; no session is restarted here.
Native credential management on macOS/Linux has not been implemented.

## Recovery artifacts

[docs/upstream/agy-auth](upstream/agy-auth/README.md) contains the pinned original credential and
quota source references, revision, synthetic fixture and MIT license. These files are not executed.
Use them to diagnose future upstream format changes. ProjectManager's implementation lives in
server/agents/antigravityNative.ts and scripts/antigravity-credential.ps1.

## Validation

Fixture tests cover encrypted snapshots, metadata-only responses, importing without activation,
keyring/file agreement, previous-login backup, failed-keyring preservation and per-account quota.
The bridge compiles without credential operations. Production user credentials were not read or
switched during validation; real login/switch and physical mobile acceptance remain unverified.
