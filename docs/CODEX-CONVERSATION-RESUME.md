# Codex restart identity

Account selection changes authentication, never a session's conversation identity. Every restart uses its pinned explicit `codex resume <id>` command. Before switching credentials or stopping a Codex process, ProjectManager verifies and pins its saved conversation. Legacy rollouts are carried from their original home to the shared runtime home when necessary.

For an unpinned process, discovery considers only main-thread rollouts in the same working directory within its launch window (five seconds before to two minutes after `started_at`), excluding already claimed conversations. More than one candidate is ambiguous. A missing or ambiguous rollout cancels the operation with an error; it never selects a later sibling, uses `--last`, or silently starts fresh. Explicit IDs in custom resume commands are also respected. A failed automatic Codex resume retains its target instead of discarding it on retry.

This deliberately replaces the older fresh-start-on-account-change fallback. Missing transcripts must be recovered or the user must deliberately create a new session. Historical incorrect assignments cannot be reliably inferred from folder/timestamp metadata alone and are not automatically rewritten. The fix does not claim to detect a different thread manually selected inside Codex's own picker without an authoritative thread notification.

Regression coverage includes distinct conversations sharing one project through repeated account switches, missing pinned rollouts, ambiguous sibling creation, late unrelated rollouts, restart progress and queued continuation. No live account switches or process restarts are used for validation.

## Screenshots in a resumed conversation (PM-276)

A running Codex sends each turn on top of the previous response, so a screenshot goes up once. A
relaunched one (restart, crash, account switch) re-sends the whole resumable history in one
request. With a dozen 2.5 MB screenshots in it, that request is dropped on every retry ("Stream
disconnected before completion … os error 10053/10054"), while the same history without its
images resumes normally. An account switch restarts every Codex session, so it surfaces there.

Before relaunching a Codex session with `resume`, the supervisor calls `slimResumeImages`
(`server/agents/codexImages.ts`). When the history Codex would rebuild (the last `compacted`
record's replacement history plus every response item after it) carries more than 8 MB of
images, it appends one `compacted` record with that same history, keeping the newest 3 images (at
most 4 MB) and replacing the others with a short note. Codex resumes from the last compaction, so
the next request is small. Nothing is rewritten: the original records, images included, stay in
the file above the new record. Only the tail after the last compaction is read (backwards from
the end), so multi-GB rollouts stay cheap. A rollout still being written, an old-style compaction
or a rollback is left alone. The session log notes how many screenshots were kept.
