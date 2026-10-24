# Account usage audit — 2026-10-24

## Corrections

- Codex quota remains bound to login identity, not a folder or email alone. Manual/automatic
  switches invalidate in-flight results; old identity-less caches and carried conversation
  usage are not accepted as account quota (b7059e4).
- The account drawer, Plan Usage endpoint and supervisor continuation reset lookup now use
  the identity-verified account-service cache. They no longer infer account quota from shared
  session history. Unknown quota stays unknown until a successful read.
- Fresh canonical default-login readings override errors attached to a stale saved credential
  copy. Individual refresh resolves the selected profile to that canonical source.
- Automatic rotation prefers an untried account with recent verified healthy quota before
  unknown candidates. Exhausted reset windows remain advisory until the next account read;
  no percentage is set to zero merely because its reset time passed.
- Visible account usage revalidates at one-minute intervals instead of ten minutes. A known
  reset passing also makes its account eligible for refresh. Concurrent reads remain bounded
  and coalesced; a failed refresh preserves the original quota observation time.
- Refresh-all now uses the same action/revision guard as switching and individual refresh,
  preventing older panel polling from replacing the action result.
- The file-scoped account RPC checks a known credential email against the service's account
  response and refuses mismatches. Tokens and raw RPC output do not reach the browser.
- Usage reset countdowns tick every second using current wall time, resynchronize after the
  document becomes visible, and stop timers on unmount. At zero they show “reset due · awaiting
  refresh”; existing percentages remain reported observations, not invented new quota.

## Evidence and limits

42 focused account, RPC, continuation, panel and countdown tests pass. Coverage includes switch
cache transfer, refresh finishing after a switch, external login replacement with the same email
but a different account ID, persistence across restart, failed refresh observation times,
canonical individual refresh, mismatched RPC identity and second-by-second reset countdown.

No live account was switched, no OAuth flow was started and no running CLI was restarted for
this audit. Actual provider quota can change between reads; this remains a sampled reading,
not a streaming quota feed. Network/auth failures are reported rather than guessed. Native CLI
cross-account continuation and real-browser visual acceptance remain owner acceptance checks.
Unknown quota candidates remain eligible for existing automatic-rotation fallback behavior;
they are never presented as verified healthy accounts.

Restart/reload the server to load the backend changes, then refresh account usage. Browser
reload loads the countdown changes. No stored credentials need to be recreated.
