# Remote Preview performance (PM-736)

Local Preview renders the website in an iframe. Remote and LAN Preview normally show an isolated
browser running on the host. The opaque sandbox used by the path proxy cannot carry the credentials
needed for every page asset through the remote access gates. Streaming keeps the app functional
without letting project code execute as ProjectManager or weakening those gates.

Streaming adds capture, encoding, transfer and decoding work. It cannot feel identical to a native
page on every connection: a click still travels to the host and its result travels back. Restoring
native rendering would require a separately isolated, authenticated origin, not adding
`allow-same-origin` to the existing sandbox.

## Problems corrected

- Stable links now use JPEG motion at every viewport size, avoiding WebP's encoding bottleneck
  even at smaller viewports. Unproven or congested links retain WebP's smaller payloads, and sharp
  settled frames remain lossless PNG.
- Sharp motion previously required a frame acknowledgement round trip below 120 ms. A stable,
  high-bandwidth remote link at 300 ms therefore stayed at 1x during motion. Quality now uses extra
  delay above the quickest recent delivery. After three stable samples it can probe full scale;
  growing queues trigger the existing reduction and cooldown. Nearby links retain immediate probes.
- A rejected acknowledgement request previously advanced the client's acknowledged version anyway.
  With the server's window full, updates could wait for its two-second escape frame. Failed requests
  now retry the latest displayed version after 200 ms, with backoff capped at one second. Only one
  acknowledgement request travels at a time, and feed cancellation stops retries.
- Once a feed was classified as buffered, the tab kept long-poll for its lifetime. A tab becoming
  visible again, or an explicit retry, now retests the pushed feed. Active fallback playback is
  preserved until that reconnection.

## Validation and limits

A regression test first reproduced the old 1x decision with stable 300 ms delivery samples. It now
checks full-scale motion, lossless settled output, and reduction when delivery grows to 1,000 ms.
Client tests cover a failed acknowledgement with no later frame and pushed-feed recovery after a
fallback tab is hidden and shown again. Existing ordering, window, format, input and isolation tests
remain in place.

An isolated real-Chrome fixture at 800×600 CSS pixels and 2x scale produced these results. Delivery
samples were seeded at 300 ms; this is a rendering-policy comparison, not a remote latency benchmark.

| Output                         | Before          | After     |
| ------------------------------ | --------------- | --------- |
| Motion pixels                  | 800×600         | 1600×1200 |
| Settled encoding               | WebP quality 90 | PNG       |
| Settled pixels                 | 1600×1200       | 1600×1200 |
| Settled bytes for this fixture | 31,380          | 75,278    |

The sharper motion carries four times as many pixels on a 2x screen. Lossless stills cost more bytes,
so full scale remains a probe with congestion backoff. This does not guarantee high resolution on a
bandwidth-limited link. No new dependencies, public origins, ports or permissions are introduced.
