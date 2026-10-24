# Recovery reference: agy-auth

Archived from https://github.com/fikrilal/agy-auth at the exact commit in REVISION.txt.
The original MIT LICENSE is included. Files retain their original source text; slashes in paths
are replaced by double underscores. These files are reference artifacts and are not executed,
compiled or installed by ProjectManager.

The Windows keyring compatibility reference is from
https://github.com/zalando/go-keyring/blob/master/keyring_windows.go (retrieved 2026-10-24), with
its license in keyring_LICENSE. It establishes the generic credential target gemini:antigravity
and UTF-8 credential blob encoding. ProjectManager's own Windows bridge lives in
scripts/antigravity-credential.ps1.

ProjectManager's native implementation lives in server/agents/antigravityNative.ts. Keep this
archive for diagnosing changes in Antigravity credential fields, storage priority and quota APIs.
No real account credential or OAuth client secret is included; the credential fixture is upstream
synthetic test data. Do not copy runtime credential files into this directory.
