# Built-in browser (PM-253): design

Goal: from any screen, including a phone on the LAN or the remote listener, open the apps an agent
is running on this computer's `localhost` ports, next to the sessions.

Status: built (PM-253). `server/localPorts.ts` detects listening apps (netstat on Windows, lsof
elsewhere), attributes them to a project by command line, and reads each app's page title and
icon. "Has an icon" means its `<link rel="icon">` (or `/favicon.ico`) was fetched and really is an
image, because a single-page dev server answers every path with its HTML; it is the cue that splits
front ends (**Apps**) from back ends (**Services**). The **Preview** page (top bar; on phones the
Agents tools menu) lists them beside a small browser. It is a global page on purpose: a dev server
is not owned by one project. There are two ways to show an app:

1. **Its own origin (this computer).** Opened on `localhost`, `127.0.0.1` or `[::1]`, the frame
   loads `http://p<port>.localhost:<our port>` (`server/previewHost.ts`, routed first in
   `server/index.ts`). The app behaves as it does on its own port: root-absolute URLs (`/src/main.tsx`,
   `/_next/...`) resolve to it, cookies and storage are its own, every method works, and its
   live-reload **WebSocket is proxied** (Vite HMR and the like; checked against a real Vite dev server).
   It is a different origin from this app, so the page cannot reach this app's API or storage, and
   this app's cookies never reach it. The frame is sandboxed with `allow-same-origin`, which only
   means its own `p<port>.localhost` origin.
2. **Read-only path mode (phones on the LAN, the remote listener, any other address).** There is no
   wildcard host name there, so the app is shown under `/api/preview/<port>/` (`server/preview.ts`):
   GET and HEAD only, a sandbox with no origin of its own, HTML URLs rewritten. Pages that build
   root-absolute URLs in JavaScript (Vite, Next) miss the proxy, and there is no WebSocket, so no
   live reload. It cannot be fixed without a host name per app. Simple and static pages work.

The proxied path address must never be opened as a top-level tab (it would run as this origin).

## The security problem comes first

The app's server can read any folder and run agent CLIs. A page served from the **same origin** as
the app could call `/api/*` with the user's session, so a hostile or compromised dev page would be
able to start agents. Therefore:

- Never serve a previewed page from the app's own origin with scripts allowed to act as that
  origin.
- Own-origin mode (`p<port>.localhost`) is routed only by the loopback listener. The LAN and remote
  listeners call the handler directly, so they never see these host names. The port comes from the
  host name and is checked like the path mode (1024+, never this app's own, LAN or remote ports);
  targets are always 127.0.0.1; a redirect that leaves the app is refused. A WebSocket upgrade must
  come from the preview's own origin (or a non-browser client), so another website cannot ride the
  proxy to a local dev server's socket, and it is handled before this app's own Vite HMR so that
  never claims a previewed app's socket.
- Never weaken the Host allowlist, the LAN gate or the remote four-check gate (see CLAUDE.md).
  The preview only exists _behind_ those gates; it adds no new listener and binds nothing wider.

## Original design (kept for the reasoning; the status above is current)

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

## Theme

The viewer's surface, border and loading mark follow the selected theme. The previewed page is the
app's own: it can only go dark if it reads `prefers-color-scheme` (which follows the browser or
operating system, not ProjectManager's theme switch) or has its own switch. Forcing a theme onto an
arbitrary page would mean rewriting its CSS, which the proxy deliberately does not do.

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
