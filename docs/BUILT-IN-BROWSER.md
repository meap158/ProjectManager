# Built-in browser (PM-253): design

Goal: from any screen, including a phone on the LAN or the remote listener, open the apps an agent
is running on this computer's `localhost` ports, next to the sessions.

Status: built (PM-253). `server/localPorts.ts` detects listening apps (netstat on Windows, lsof
elsewhere), attributes them to a project by command line, and reads each app's page title and
icon. The cue that splits front ends (**Apps**) from back ends (**Services**) is `web`: "/" answered
2xx with an HTML content type and a body that is a page (an empty HTML reply from a back end is not
one). The icon is separate: a small inline `data:image/...` icon is used as declared (parsed
quote-aware), otherwise the declared path, then `/favicon.ico`, `/favicon.svg`, `/favicon.png`, each
fetched and kept only if it really is an image (a single-page dev server answers every path with its
HTML). The **Preview** page (top bar; on phones the
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

The browser has real tabs (`previewTabs.ts` holds the state transitions, `PreviewTabStrip.tsx` the strip
and context menu): new, close, close others or to the right, duplicate, pin, reorder, reload, per-tab
back and forward, and reopen closed tab. Each open page keeps its own frame, so switching tabs keeps
the page as it was. Several tabs on one app are fine in own-origin mode (they share its cookies and
storage, like real tabs on one site).

The proxied path address must never be opened as a top-level tab (it would run as this origin).

**Actions on a listed app (PM-270).** Right click (or Shift+F10 / the Menu key) on an app: Open,
Open in new tab, Copy address (`http://localhost:<port>/`), Go to project (when attributed), and
Stop process. Each row also has a Stop button (on hover or focus; always on touch). Stopping asks
for confirmation with the pid, executable and command line, then `POST /api/local-apps/:port/stop
{ pid }` ends that process and its children (`taskkill /pid <pid> /T /F` on Windows, SIGTERM
elsewhere; argument arrays only). The server first runs a fresh detection and stops the pid only if
it is still the one listening on that port. So a stale list can't hit a process that reused the pid,
and this app's own ports and system services, which never reach the list, can't be stopped. It
also refuses this server's own pid and its launcher's. It answers on this computer only: the LAN
and remote listeners get 403.

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

## Element picker (PM-311)

The Preview toolbar's **Select element** button lets you point at something in the page, draw on
it, and send both to a CLI session. Both proxies add one script to HTML pages for this
(`server/previewPicker.ts`): inline in the path mode (whose responses carry no page CSP), and as
`/__pm-picker.js` from the page's own origin in the own-origin mode (allowed by a CSP's `'self'`; a
page whose CSP forbids it simply can't be picked). The own-origin proxy asks the app for page loads
uncompressed so it can add the tag after `<head>` as the page streams.

The script does nothing until the framing ProjectManager window posts `start`. Then hovering
outlines an element with its tag, size and (on a React development build) component; ↑ and ↓ move
to the parent and back, Enter picks, as the keyboard alternative. A click or tap reports: the page
address and title,
a CSS selector, trimmed `outerHTML` and text, the accessible role and name, its box and the
viewport, a few computed styles, and, on a React development build, the nearest component, its
plain props and the components around it. The picked element stays outlined, following the page
as it scrolls. `pause` stops hovering (while drawing), `clear` drops the pick, `stop` ends both, and
`state` asks for the page's address, size and scroll. Esc ends it. It runs only in the top-level
previewed page, never in nested frames, never sends requests and changes nothing in the page
beyond its own outlines.

**Marking up the live page** (`PreviewMarkup`), as in the Claude app: while on, a toolbar floats at
the foot of the Preview with Select, Draw, Box and Text, four colours, Undo, the picked element
(with a button to clear it) and **Add to chat**. Select hands the pointer to the page's picker;
the drawing tools put a transparent layer over the page, which covers it exactly, so marks are in
the page's CSS pixels. Add to chat asks the page where it is now and opens the dialog with the
element, if any, and the marks; marks alone, without an element, are fine too.

The app accepts the message only from the shown tab's frame while picking, keeps known fields of
bounded size (`parsePicked`, `parsePage`), and the dialog shows "What should change?", the context (editable,
with the app's own address rather than the proxy's), and a session to send to (the app's project
first, then the most recently messaged). Sending types it into that session after whatever is in
its input and presses Enter; it never clears the input.

**Screenshot and annotation.** The app cannot capture a framed page of another origin, so the
server retakes it (`server/previewCapture.ts`, `POST /api/preview-capture`): a headless Chrome, or
Edge, opens the same address at the same viewport size, scroll and colour scheme and returns a
PNG. Smooth scrolling, transitions and animations are switched off in that copy, so the scroll lands
at once and scroll-reveal effects show their end state, and the picked element is measured again
there (`x-pm-element`), so its box lands where it really is.

**As you saw it.** When Add to chat is pressed, before the dialog opens, the picker takes a
snapshot of the page as it is: a copy of its DOM with the current form values, canvases (as
images), scroll positions, open `<details>` and script-added styles written in, and scripts, this
picker's outlines and nested frames left out (the live page is untouched). The capture renders
that snapshot on the app's own origin with JavaScript off for the whole capture, so nothing
re-renders it and no handler in it runs, restores the recorded scrolls and shoots it; the dialog
says "As you saw it". Snapshots are capped at 8 MB. When there is none (too large, or a page the
picker cannot read), it falls back to a fresh load, without the viewer's cookies or open menus, and
says "Retaken by ProjectManager". Only a loopback dev server by port and path (the proxy's rules, never this app's
ports); every document load that leaves the app is refused (CDP Fetch), so it cannot be pointed at
another site. One browser, started on first use with its profile in the data folder, one capture
at a time with a timeout, closed after three idle minutes and when the server exits; no new
dependency (CDP over Node's WebSocket). Without Chrome or Edge the message goes without a picture.

The dialog keeps the screenshot's place at the page's shape from the moment it opens, so it never
changes size when the picture arrives. It shows the screenshot with the picked element boxed and the
live page's marks scaled in, and the same tools to add more (`AnnotatedShot` on the shared
`Markup` layer, drawn in the image's own pixels). Sending uploads the marked-up PNG like a chat
image and pastes its path before the message.

**Expand** (as in the Claude app's browser): the button at the right end of the tab strip, or
Ctrl+Shift+\ (`preview.expand`, reassignable in Settings > Keyboard shortcuts), makes the browser
fill the whole window, over the top bar, the sidebar and the apps list; the same button or key
restores the layout. Esc is left to the previewed page. A key pressed while the page itself has
focus goes to the page (its frame is another origin), so click the toolbar first.

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
