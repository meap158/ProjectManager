# Built-in browser (PM-253): design

Goal: from any screen, including a phone on the LAN or the remote listener, open the apps an agent
is running on this computer's `localhost` ports, next to the sessions.

Status: design only. Nothing here is built yet.

## The security problem comes first

The app's server can read any folder and run agent CLIs. A page served from the **same origin** as
the app could call `/api/*` with the user's session, so a hostile or compromised dev page would be
able to start agents. Therefore:

- Never serve a previewed page from the app's own origin with scripts allowed to act as that
  origin.
- Never weaken the Host allowlist, the LAN gate or the remote four-check gate (see CLAUDE.md).
  The preview only exists _behind_ those gates; it adds no new listener and binds nothing wider.

## Recommended design

1. **A "Preview" tab on the project page** (and a pane type in Agents later) holding an address
   bar (port or `localhost:port/path`), back, forward, reload, open-in-new-tab, and a list of
   ports the project's sessions are listening on (detected, not guessed).
2. **A same-server reverse proxy** at `/preview/<port>/...` that forwards to `127.0.0.1:<port>`
   only. It is what makes `localhost` apps reachable from a phone or through the tunnel, because
   the browser never needs to reach the computer's loopback itself.
   - Target is **always** `127.0.0.1`/`::1` and a port from the request; no other host, no
     redirect following to other hosts (redirects are rewritten back under `/preview/<port>/`).
   - Port rules: 1024-65535, never the app's own port, the LAN listener port or the remote
     listener port. Optionally require that the port is owned by a process started from a
     ProjectManager session (stricter default; a setting can allow any loopback port).
   - Method and body pass through, request size capped, `Host`/`Origin`/`Cookie` headers rewritten
     so the app's own cookies are never sent to the previewed page.
   - WebSocket upgrades are proxied (Vite/Next HMR), under the same port rules.
3. **Isolation for the page**: render it in an `<iframe sandbox="allow-scripts allow-forms
allow-popups">` **without** `allow-same-origin`, so it gets an opaque origin: it cannot read
   the app's cookies or call `/api` with them. Responses from `/preview` also carry
   `Content-Security-Policy: frame-ancestors 'self'` and `X-Content-Type-Options: nosniff`.
   - Trade-off: apps that need `localStorage` or cookies under their own origin may misbehave in
     the sandbox. Offer a clearly labelled **"Allow storage"** toggle per port that adds
     `allow-same-origin` only when the proxy serves that port from a **separate origin** (see
     below); never combine `allow-same-origin` with the app's own origin.
4. **Separate-origin option (phase 2)**: on the local machine, `http://p<port>.localhost:<app
port>/` is a different origin from `localhost`. Add those names to the Host allowlist only for
   the loopback listener. Not available through LAN or remote (single Host), where phase 1 applies.
5. **Audit**: log each preview port opened (`[preview]` prefix), and show the active target in the
   address bar so it is obvious what is being displayed.

## Out of scope for the first cut

- Devtools, extensions, tabs inside the preview, downloads, file uploads.
- Previewing non-loopback sites (this is not a general web proxy; any external URL opens in a new
  browser tab).
- Screenshot streaming. If the sandboxed iframe proves too limiting, the fallback is a headless
  browser that streams frames, which needs a new dependency and is a separate decision.

## Test plan

- Proxy refuses non-loopback targets, the app's own ports, ports below 1024, and rewrites
  redirects; Host/Origin checks still apply to `/preview`.
- A page under `/preview` cannot read `document.cookie` of the app or `fetch('/api/...')`
  successfully (sandbox without `allow-same-origin`).
- WebSocket upgrade works for a Vite dev server; closes with the iframe.
- LAN and remote clients can use `/preview`; LAN settings stay refused for LAN clients.

## Build order

1. Land the project Files tab (PM-252), since both change `ProjectPage.tsx` and `server/app.ts`.
2. Proxy + port rules + tests (server only).
3. Preview tab UI with the sandboxed iframe, address bar and detected ports.
4. Docs: README, DESIGN.md, CLAUDE.md architecture map and security paragraph.
