# OmniRoute and ProjectManager's account switching and usage reading (PM-281)

Evaluated 2026-10-26 from the public repository `cheaper-inference/OmniRoute` (MIT, TypeScript, very active): its README,
`docs/OMNIROUTE_QUOTA_TELEMETRY.md` and `docs/guides/USAGE_QUOTA_GUIDE.md`. Nothing was installed or run. The code behind
those documents was not read line by line, so the comparison below is of designs as documented.

## What OmniRoute does

It is a gateway: your tools send requests to one local endpoint, and it forwards them to a provider chosen by routing rules
(many providers, free tiers, accounts pooled behind one endpoint, automatic fallback when a quota runs out). Its usage and
quota numbers come from the requests that pass through it (tokens and cost per request, per API key) plus provider usage
APIs where they exist, and are summarised as truthful states.

## What ProjectManager does

It does not sit in the request path. Each agent CLI (Codex, Claude Code, Antigravity, Grok) keeps its own login and talks to
its own provider. ProjectManager saves the logins as separate profiles, switches which one a CLI starts under, reads each
profile's own usage windows (5-hour, weekly, with reset times), can switch automatically for eligible accounts, and keeps a
conversation resumable across a switch (docs/CODEX-CONVERSATION-RESUME.md).

## Comparison

| Topic | OmniRoute | ProjectManager | Verdict |
| --- | --- | --- | --- |
| Where usage comes from | requests it proxies, plus provider usage APIs | each CLI's own usage and statusline data per profile | Different by design; ours reads what the subscription actually reports |
| Truthful states (`unknown` is not `exhausted`) | explicit: healthy, approaching limit, exhausted, unavailable, unknown | the same principle: an unreadable or reset window is unknown, not exhausted (planner fix 2026-10-25) | Already aligned; nothing to borrow |
| Rotation when a limit is hit | automatic, across pooled accounts | auto-switch for accounts marked eligible, then resume the conversation | Already have the useful part |
| Reset countdowns, windows | per provider quota snapshots | per window `resetsAt` shown in the account panels and the Inbox | Already have |
| Health of saved logins | provider health checks | Check and refresh in the panels | Comparable |
| Security model | holds many providers' keys and logins in one gateway; pools consumer subscription logins behind one endpoint | each login stays in its own profile and is never shared between accounts | Theirs is a different risk model (see below) |

## Why it is not adopted

- Putting a gateway between the CLIs and providers would make it the holder of every credential and would route every prompt
  through it. That changes the project's security model (CLAUDE.md: credentials of one account are never exposed to
  another) and is out of scope unless the owner asks.
- Several of its headline features pool consumer subscription logins or free tiers behind one endpoint. Using a subscription
  login outside the vendor's own client is commonly against the provider's terms and can get the account limited or
  banned. ProjectManager deliberately launches the vendor's own CLI.
- Its usage numbers describe requests it forwards. ProjectManager's CLIs do not go through it, so it would see none of
  the traffic whose limits matter here.

## Borrowed and built

Nothing new was needed: the one transferable idea (honest `unknown` versus `exhausted`) is already how usage is handled.
No code was changed for this card.

## If something is wanted later

- A single "all accounts at a glance" view with reset countdowns (the pieces exist per provider; a combined strip is a UI task).
- A periodic background refresh of each saved login's health, shown as a quiet badge (needs care not to spend quota).
- Both are product choices for the owner; neither depends on OmniRoute.
