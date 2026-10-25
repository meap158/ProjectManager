# Codex restart identity

Account selection changes authentication, never a session's conversation identity. Every restart uses its pinned explicit `codex resume <id>` command. Before switching credentials or stopping a Codex process, ProjectManager verifies and pins its saved conversation. Legacy rollouts are carried from their original home to the shared runtime home when necessary.

For an unpinned process, discovery considers only main-thread rollouts in the same working directory within its launch window (five seconds before to two minutes after `started_at`), excluding already claimed conversations. More than one candidate is ambiguous. A missing or ambiguous rollout cancels the operation with an error; it never selects a later sibling, uses `--last`, or silently starts fresh. Explicit IDs in custom resume commands are also respected. A failed automatic Codex resume retains its target instead of discarding it on retry.

This deliberately replaces the older fresh-start-on-account-change fallback. Missing transcripts must be recovered or the user must deliberately create a new session. Historical incorrect assignments cannot be reliably inferred from folder/timestamp metadata alone and are not automatically rewritten. The fix does not claim to detect a different thread manually selected inside Codex's own picker without an authoritative thread notification.

Regression coverage includes distinct conversations sharing one project through repeated account switches, missing pinned rollouts, ambiguous sibling creation, late unrelated rollouts, restart progress and queued continuation. No live account switches or process restarts are used for validation.
