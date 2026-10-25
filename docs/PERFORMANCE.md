# Performance

How fast ProjectManager loads and answers, how to measure it, and what has been tuned.

## Measuring

```sh
npm run bench                                   # bundle + API, against http://127.0.0.1:5180
node scripts/benchmark-app.mjs --api --only agent-sessions,cards --runs 30
node scripts/benchmark-app.mjs --stalls 60      # event-loop stalls from background work
node scripts/benchmark-app.mjs --bundle --out docs/perf/<name>.json
```

`scripts/benchmark-app.mjs` is read-only: the client is built in memory (nothing written, a running
dev server untouched) and the API is hit with GET requests only. For each endpoint the pages read it
reports median and p95 latency (after two warm-up requests), the body size, the gzip size and a
revalidation request with the ETag. Results are JSON; saved runs live in `docs/perf/`.

Run it against the live app with your real data. Latency on this machine varies with the agents
running at the time, so compare runs taken minutes apart, and treat differences of a few
milliseconds on the small endpoints as noise.

## Audit, 2026-10-26 (PM-294)

Data at the time: 28 projects, 292 cards, 77 agent sessions (31 running), dev server on the `S:`
drive. Before: `docs/perf/baseline-2026-10-26.json`; after: `docs/perf/after-2026-10-26.json`.

### API (median / p95, ms, 30 runs)

| Endpoint                      | Before        | After       | Notes                                    |
| ----------------------------- | ------------- | ----------- | ---------------------------------------- |
| `/api/agent-sessions`         | 116.4 / 273.9 | 18.8 / 20.6 | polled every few seconds by every page   |
| `/api/orchestrators/overview` | 99.4 / 349.1  | 27.2 / 29.1 | embeds the session list; polled every 5s |
| `/api/cards`                  | 37.4 / 330.9  | 20.5 / 26.5 | 0.58 MB (189 KB gzip); Board, every 10s  |
| `/api/projects`               | 11.3 / 20.1   | 7.5 / 9.9   |                                          |
| `/api/cards/in-flight`        | 16.1 / 26.9   | 9.1 / 10.0  |                                          |

Revalidating an unchanged list (the board's poll, in the browser): **300 bytes instead of 194 KB**
on the wire, 304 in 3–7 ms server-side. The session list and the overview change on every poll
(log sizes, output times), so they are always sent in full; that is why making them cheap mattered.

### Client bundle (production build)

| Measure                  | Before   | After    |
| ------------------------ | -------- | -------- |
| First-visit JS (gzip)    | 110.5 KB | 109.0 KB |
| First-visit JS (brotli)  | 95.8 KB  | 94.5 KB  |
| All JS, 22 chunks (gzip) | 459 KB   | 459 KB   |

The first visit was already lean: every page is a lazy route and most of the entry chunk is React
and React Router. Warm reload of the Dashboard in the dev server: first paint ~110 ms.

### Background work (event-loop stalls)

Timers run on the same thread that answers requests and streams terminals, so a slow tick freezes
the whole app. `--stalls` reads a trivial endpoint every 50 ms for a minute and records the jumps.

| 60 s probe        | Before                                 | After                   |
| ----------------- | -------------------------------------- | ----------------------- |
| Stall every 10 s  | 170–340 ms                             | 50–85 ms                |
| p99 / max latency | 58 ms / 337 ms                         | 33 ms / 85 ms           |
| Source            | Codex auto-continue/limit check (10 s) | same tick, much cheaper |

Found by timing every timer callback (a temporary wrapper, removed). The 10 s Codex check rendered
every running Codex session's screen (a terminal emulation over 256 KB of log, 80–140 ms for 9
sessions) and read account quota per session (`state()` 6.7 ms, login 2.7 ms, each). With all
accounts at their limit, every limited session also recomputed the same switch decision. The
remaining ~55 ms happens only while a session shows its limit (it was the case for every Codex
account during the audit); with none at a limit the tick is a few milliseconds.

### Project page (this repository, 15 runs)

| Endpoint                          | Median | Notes                                                                   |
| --------------------------------- | ------ | ----------------------------------------------------------------------- |
| `/api/projects/14`                | 1.6 ms |                                                                         |
| `/api/projects/14/cards`          | 9.7 ms | 228 KB; revalidates as a 304 when unchanged                             |
| `/api/projects/14/agent-sessions` | 6.2 ms |                                                                         |
| `/api/projects/14/tree?path=`     | 40 ms  | root listing with git status                                            |
| `/api/projects/14/pull-requests`  | 894 ms | GitHub's round trip through `gh`; loaded once per tab visit, not polled |

### Pages in the browser (dev server, warm reload)

| Page                         | First paint | Data in | Notes                                                   |
| ---------------------------- | ----------- | ------- | ------------------------------------------------------- |
| Board (292 cards)            | 104 ms      | 411 ms  | no long tasks (>50 ms) while rendering; 2,430 DOM nodes |
| Project, Files tab           | 128 ms      | ~200 ms | root tree in 59 ms (35 rows)                            |
| Orchestrators                | 164 ms      | ~550 ms | overview 80 ms in the browser (61 KB)                   |
| Server restart (`tsx watch`) | –           | 1.3 s   | API answering again, Vite included; first list in 31 ms |

The Board renders every card; it is not slow today, but Done alone holds 225 cards and grows.
Virtualizing long columns, capping Done and a compact density are tracked in PM-296; measure
scroll smoothness there in a focused browser window (automated tabs throttle animation frames).

### What changed

1. **Session list: one credential read per list, not per row.** Each Codex session row asked for
   the selected Codex login, which re-reads the account registry and compares the default
   `auth.json` with every saved one (2.7 ms each; 18 Codex rows ≈ 48 ms per request). It is now
   read once per list (`SessionBatch.codexProfile`).
2. **Session list: `.base` sidecars from one folder listing.** Every row tried to read its log's
   `<log>.base` (only compacted logs have one, 20 of 77), and the failed reads cost ~12 ms per
   request on Windows. One `readdir` per list now says which exist.
3. **Session list: unchanged log tails are not re-read.** The activity of each running session
   comes from its log's last 4 KB. The tail is cached against the size and modified time the list
   already stats, so an idle session's log is not opened again (31 reads ≈ 11 ms per request).
4. **Conditional GETs for JSON reads** (`server/jsonEtag.ts`): a weak ETag of the uncompressed
   body plus `Cache-Control: private, no-cache`. Browsers revalidate on every poll and get a
   bodiless 304 when nothing changed. Streams and writes are untouched.
5. **Board polling** uses `serialPoll`: paused while the tab is hidden, and never overlapping.
6. **Add project dialog** is loaded on first use instead of with every page.
7. **Codex limit check: screens rendered only when they can have changed.** An unchanged log (and
   terminal size) reuses the last render; a log still being written is re-rendered at most every
   30 s, since Codex goes quiet once it hits the limit and the tick after it settles renders it at
   once. Quota is read only when the limit message is on screen, and the switch decision is made
   once per tick (all Codex CLIs share one login), not once per session.
8. **Session name sync** (every 10 s): the CLI title lookups parse only lines that can match
   (`custom-title` for Claude, the conversation id for Codex) instead of up to 1 MB of JSON per
   session, parse lazily, and read the Codex login once per pass.
9. **Running-session pulse** (the green ring on a working session's dot) animates `transform`
   and `opacity` on a pseudo-element instead of `box-shadow`. Same look (8 px dot, 5 px ring at
   45% green fading out, the dot's own colour drawn on top), but composited instead of repainting
   every running dot on every frame. Reduced motion still shows no ring.
10. **Running-app detection** (Preview, and the sidebar globe from PM-297) caches each process's
    name and command line per pid and shares concurrent scans: a scan after the 3 s cache costs
    one `netstat` (~40 ms) instead of netstat plus a PowerShell query (0.72 s). Fresh scans
    (Refresh, Stop's safety re-check) skip the cache.
11. **Codex auto-switch setting** is read on its own instead of through the full account state
    (6.7 ms), and recovered-quota checks read the logins once per tick (`4cf95a2`).

### Checked and left as is

- Visual effects: no `transition: all`; hover effects and transitions are unchanged. The other
  endless animations (loading mark, chat pulse, idle blink, spinners) already animate `opacity` or
  `transform`; the only blur is the image lightbox backdrop.
- Pull requests are network-bound (`gh pr list` + repo settings, in parallel, token cached).
  Caching them would show stale state after merges made elsewhere.

- Compression: JSON responses were already gzipped (`hono/compress`), LAN/remote visitors already
  get a production bundle, and hashed assets are cached for a year.
- Overlapping identical GETs are already shared (`pendingReads` in `client/src/api.ts`), and
  unchanged polled lists return the previous object so React skips re-rendering.
- `motion` (57 KB gzip) loads with the Dashboard for the Rare UI animated counters; it is not in
  the first-visit bundle.
- The overview carries full project summaries (172 KB) for the attention view; at 61 KB gzip on
  a 5 s poll it was not worth a second, narrower project shape.

### Not ProjectManager, but worth knowing

The Codex CLI keeps every conversation in `~/.codex/sessions` (21 GB on 2026-10-26, three
long-running conversations of 8.4, 4.6 and 2.6 GB) plus an 8.5 GB `thread_history_1.sqlite`. That
filled the `C:` drive during this audit. Archiving old conversations is the owner's call.
