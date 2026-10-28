# Account switcher audit

All four switchers use the existing account drawer actions and usage meter/countdown components. Shared server policy in `server/agents/accountPolicy.ts` defines the 60-second freshness limit, rejects future timestamps and validates quota windows. Provider-specific storage and authentication remain separate because their credential formats differ.

| Provider    | Account switching                                                       | Usage source                                  | Automatic rotation                                    |
| ----------- | ----------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| Codex       | Default auth file, captures refreshed credentials before replacement    | Identity-bound account service                | Supported, opt-in setting and per-profile eligibility |
| Claude Code | Native credentials file and saved profiles                              | Token-bound status-line reports from sessions | Supported, opt-in (see below)                         |
| Grok        | Native OIDC auth document and encrypted saved profiles                  | Credential-bound Grok billing response        | Not implemented                                       |
| Antigravity | Windows Credential Manager plus native mirror; encrypted saved profiles | Credential-bound Google quota response        | Not implemented                                       |

Codex automatic switching requires fresh identity-verified exhaustion and non-ended work. Every affected session must have no working turn or queued input; executing Codex runs defer rotation so grace turns can finish. A limit-failed run waits, rechecks usage and respects stop/delete, manual selection and disabling automatic switching. Only limit-blocked sessions receive Continue. Ended sessions remain ended. Rank eligible accounts by remaining 5-hour quota, then weekly quota, then saved top-to-bottom order (whole percentages). Every reported window must have fresh positive quota. Missing windows use verified limiting remaining quota, never an invented allowance. Unknown, malformed, stale, future, failed and reset-due readings cannot authorize switching. With no eligible account, stay put. The info button beside the setting explains this policy.

Usage ownership is checked independently of the selected row. Codex binds its readings to account identity and discards in-flight results after credential selection changes. Claude uses token-specific report directories and refuses to attribute an unrelated live credential to a remembered selected profile. When both Claude tokens change without verifiable continuity, the live credential is treated as a default login, rather than overwriting a saved profile; save it again to retain that login. Grok and Antigravity bind in-memory readings to the exact credential document, discard old cached usage on changes, and start unknown after a server restart. Antigravity refreshes stale readings while its drawer is queried, like Grok. Failed queries show unknown quota. Provider reset timestamps drive the live countdown; elapsed timestamps never fabricate 0% usage or replenished quota.

Selecting the already-active Antigravity profile is a no-op and preserves refreshed live credentials. Removing a saved profile does not log out the live account. Codex may additionally refuse removal while session/run references still require its stored history.

Validation uses temporary homes, in-memory databases, injected provider responses and CLI fixtures. It covers account selection, token recapture, usage ownership, stale/error/reset states, rankings, opt-outs, ended-session guards, external Claude logins and switch recovery. Live credential shapes and default-email loading have been checked read-only; automated tests do not switch the user's real accounts or restart their active CLI sessions. Real provider switching and physical mobile layout remain acceptance checks, not claimed as tested.

Exhaustion (2026-10-27): the meter must still read zero left. When a session or run also prints the CLI's own usage-limit message, a fresh verified reading with 5% or less left is enough, and usage is re-read after 15 seconds instead of 60. An unknown, stale or errored reading authorizes nothing, and a candidate needs at least 1% left.

Claude Code rotation (2026-10-27) is opt-in under Settings > Agent CLIs. It uses each login's status-line reading (for a saved login, a lower bound, since nothing spends it while unselected) and the CLI's own limit message. It switches the login, restarts idle sessions with their conversation resumed, and sends Continue to the ones that were blocked. A busy session is left alone, a login left is skipped for five hours, and a restarted session's old limit message is ignored until it has taken a turn. See `server/agents/claudeRotation.ts`.

## What the next switch will be (forecast)

Settings shows, under the account in use, what automatic switching will do next once that account
is at or below 10% left (`switchForecast` in `server/agents/accountPolicy.ts`, returned as
`forecast` with the accounts state). It uses the switcher's own ranking: an eligible account with
quota left now, best 5-hour then weekly then list order, named as the next switch. When no
account has quota it names the one whose quota comes back first (the later of its spent windows'
resets, so a spent weekly counts), and when that is the account in use, sessions simply continue
there. It reads the latest readings without the one-minute freshness rule, so it is labelled a
forecast; the switch itself still requires fresh, verified readings.

Settings also shows the supervisor's live waiting reason and a countdown to its next 10-second
check while a switch forecast is visible. This is a check countdown, since working sessions,
queued input, approvals, active runs or unverified quota can defer the switch. The panel
follows this state every five seconds and ticks the countdown each second. Failed automatic
session switches appear here and in the server log, and the next supervisor tick retries after
rechecking quota and the same safety guards.

The starting-process guard only covers starting Codex sessions. A run remains in the starting
set until it exits, so treating that whole set as busy prevented a limit-blocked run from
switching. Active Codex runs still defer rotation; runs already waiting for quota do not.

Draft text or a missing readable empty prompt does not block account rotation (owner decision,
2026-10-29). Working turns, queued input and approval prompts still defer it. Waiting messages
identify the session by its name and number. The allowance-reset Continue path retains its
empty-prompt check; account rotation still sends Continue only to limit-blocked sessions.
