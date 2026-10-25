# Performance

How fast ProjectManager loads and answers, how to measure it, and what has been tuned.

## Measuring

```sh
npm run bench                                   # bundle + API, against http://127.0.0.1:5180
node scripts/benchmark-app.mjs --api --only agent-sessions,cards --runs 30
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

### Checked and left as is

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
