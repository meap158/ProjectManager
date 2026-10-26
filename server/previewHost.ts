import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import { PreviewError, parsePreviewPort } from './preview.js';
import { PICKER_EXTERNAL, PICKER_JS, PICKER_PATH, injectPicker } from './previewPicker.js';

// Built-in browser, phase 2 (docs/BUILT-IN-BROWSER.md): a previewed dev server gets its OWN origin,
// `http://p<port>.localhost:<our port>`, so it behaves like it does on its own port: root-absolute
// URLs ("/src/main.tsx", "/_next/...") resolve to the app, cookies and storage are its own, forms
// and API calls work, and its live-reload WebSocket (Vite, Next, webpack) is proxied.
//  - THIS COMPUTER ONLY. Browsers resolve *.localhost to the loopback, and only the loopback
//    listener routes these hosts (index.ts); the LAN and remote listeners never see them and keep
//    the read-only path mode in preview.ts.
//  - The origin differs from the app's (`localhost:<our port>`), so the previewed page cannot read
//    this app's API or storage, and the app's cookies never reach it (cookies are host-scoped).
//  - Targets are always 127.0.0.1; the port comes from the host name and is checked like the path
//    mode's (1024+, never this app's own ports). Redirects off the app are refused.
//  - A WebSocket upgrade must come from the preview's own origin (or no browser origin at all), so
//    another website cannot ride the proxy to a local dev server's socket.

const HOST_RE = /^p(\d{4,5})\.localhost(?::\d+)?$/i;

/** The app port a `p<port>.localhost` host name asks for; null for every other host. */
export function previewHostPort(hostHeader: string | undefined): number | null {
  const match = HOST_RE.exec(hostHeader ?? '');
  return match ? Number(match[1]) : null;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);
/** Never forwarded: markers this app uses between its own listeners. */
const OURS = new Set(['x-pm-lan', 'x-pm-remote', 'cf-access-jwt-assertion']);

/** `http://p5180.localhost:5291` -> `http://localhost:5180`, so the app sees its own address. */
export function rewriteToApp(value: string, hostHeader: string, port: number): string {
  const own = `http://${hostHeader}`;
  return value.startsWith(own) ? `http://localhost:${port}${value.slice(own.length)}` : value;
}

/** Where an app's redirect should go; null when it points somewhere other than the app itself. */
export function rewriteAppLocation(location: string, port: number): string | null {
  if (location.startsWith('//')) return null;
  if (location.startsWith('/') || !/^[a-z][a-z0-9+.-]*:/i.test(location)) return location;
  try {
    const url = new URL(location);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol === 'http:' && loopback && Number(url.port || 80) === port) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // Malformed: refused below.
  }
  return null;
}

/** The app's own CSP minus any frame-ancestors, plus ours: only this app may frame the preview. */
export function withFrameAncestors(csp: string | undefined, ancestors: string): string {
  const kept = (csp ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !/^frame-ancestors\b/i.test(part));
  return [...kept, `frame-ancestors ${ancestors}`].join('; ');
}

/** The origins that may frame a preview: this app, however it was opened on this computer. */
function parentOrigins(hostHeader: string): string {
  const port = /:(\d+)$/.exec(hostHeader)?.[1];
  const suffix = port ? `:${port}` : '';
  return `http://localhost${suffix} http://127.0.0.1${suffix} http://[::1]${suffix}`;
}

function requestHeaders(headers: IncomingHttpHeaders, hostHeader: string, port: number) {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (
      HOP_BY_HOP.has(key) ||
      OURS.has(key) ||
      key.startsWith('x-forwarded-') ||
      value === undefined
    )
      continue;
    out[key] =
      (key === 'origin' || key === 'referer') && typeof value === 'string'
        ? rewriteToApp(value, hostHeader, port)
        : value;
  }
  out.host = `localhost:${port}`;
  return out;
}

function fail(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(message);
}

const TIMEOUT_MS = 30_000;

/** Proxies one request of any method to the app, streaming both ways. */
export function proxyPreviewHost(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  blocked: ReadonlySet<number>,
): void {
  const hostHeader = req.headers.host ?? '';
  try {
    parsePreviewPort(String(port), blocked);
  } catch (error) {
    fail(res, error instanceof PreviewError ? error.status : 400, (error as Error).message);
    return;
  }
  // The element picker (PM-311) is served from the page's own origin, so a CSP allowing 'self'
  // lets it load; it stays inert until the app frames the page and asks.
  if (req.method === 'GET' && req.url === PICKER_PATH) {
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(PICKER_JS);
    return;
  }
  const headers = requestHeaders(req.headers, hostHeader, port);
  // A page load: ask for it uncompressed, so the picker can be added to the HTML as it streams.
  const pageLoad = req.method === 'GET' && /text\/html/i.test(String(req.headers.accept ?? ''));
  if (pageLoad) headers['accept-encoding'] = 'identity';
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port,
      method: req.method,
      path: req.url,
      headers,
      timeout: TIMEOUT_MS,
    },
    (appRes) => {
      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(appRes.headers)) {
        const key = name.toLowerCase();
        if (key === 'x-frame-options' || key === 'content-security-policy' || value === undefined)
          continue;
        headers[key] = value;
      }
      const location = appRes.headers.location;
      if (location) {
        const rewritten = rewriteAppLocation(location, port);
        if (!rewritten) {
          appRes.resume();
          fail(res, 403, 'The page redirected somewhere other than itself');
          return;
        }
        headers.location = rewritten;
      }
      headers['content-security-policy'] = withFrameAncestors(
        appRes.headers['content-security-policy'] as string | undefined,
        parentOrigins(hostHeader),
      );
      const html =
        pageLoad &&
        /^text\/html\b/i.test(String(appRes.headers['content-type'] ?? '')) &&
        !appRes.headers['content-encoding'];
      if (html) delete headers['content-length'];
      res.writeHead(appRes.statusCode ?? 502, appRes.statusMessage, headers);
      if (html) streamWithPicker(appRes, res);
      else appRes.pipe(res);
      appRes.on('error', () => res.destroy());
    },
  );
  upstream.on('timeout', () => {
    upstream.destroy();
    fail(res, 504, `Nothing answered on port ${port} in time`);
  });
  upstream.on('error', () => fail(res, 502, `Nothing is listening on port ${port}`));
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

let openSockets = 0;
const MAX_SOCKETS = 64;

function refuse(socket: Duplex, status: number, text: string) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Proxies a WebSocket upgrade (live reload, HMR) for a `p<port>.localhost` host. Returns false
 * when the host is not one, so the caller leaves the upgrade to everything else.
 */
export function handlePreviewUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  blocked: ReadonlySet<number>,
): boolean {
  const hostHeader = req.headers.host ?? '';
  const port = previewHostPort(hostHeader);
  if (port === null) return false;
  // Taken: nothing else (this app's own Vite HMR looks at the subprotocol) may also claim it.
  const subprotocol = req.headers['sec-websocket-protocol'];
  delete req.headers['sec-websocket-protocol'];
  try {
    parsePreviewPort(String(port), blocked);
  } catch {
    refuse(socket, 403, 'Forbidden');
    return true;
  }
  // Only the preview's own page (or a non-browser client) may open the socket.
  const origin = req.headers.origin;
  if (origin && origin !== `http://${hostHeader}`) {
    refuse(socket, 403, 'Forbidden');
    return true;
  }
  if (openSockets >= MAX_SOCKETS) {
    refuse(socket, 503, 'Too many open previews');
    return true;
  }
  const headers = requestHeaders(req.headers, hostHeader, port);
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';
  if (subprotocol) headers['sec-websocket-protocol'] = subprotocol;
  openSockets++;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    openSockets--;
  };
  const upstream = http.request({
    host: '127.0.0.1',
    port,
    method: 'GET',
    path: req.url,
    headers,
  });
  upstream.on('upgrade', (appRes, appSocket, appHead) => {
    const lines = [`HTTP/1.1 101 ${appRes.statusMessage || 'Switching Protocols'}`];
    for (let i = 0; i < appRes.rawHeaders.length; i += 2) {
      lines.push(`${appRes.rawHeaders[i]}: ${appRes.rawHeaders[i + 1]}`);
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (appHead.length) socket.write(appHead);
    if (head.length) appSocket.write(head);
    appSocket.pipe(socket);
    socket.pipe(appSocket);
    const close = () => {
      finish();
      appSocket.destroy();
      socket.destroy();
    };
    appSocket.on('error', close);
    socket.on('error', close);
    appSocket.on('close', close);
    socket.on('close', close);
  });
  // The app answered without upgrading (not a socket endpoint, or it refused).
  upstream.on('response', (appRes) => {
    finish();
    appRes.resume();
    refuse(socket, appRes.statusCode ?? 502, appRes.statusMessage || 'Bad Gateway');
  });
  upstream.on('error', () => {
    finish();
    refuse(socket, 502, 'Bad Gateway');
  });
  socket.on('error', () => upstream.destroy());
  upstream.end();
  return true;
}

/**
 * Streams an HTML page through, adding the picker tag right after `<head>`: the start is held
 * until the tag (or 64 KB) has gone by, then the rest flows unchanged.
 */
function streamWithPicker(appRes: IncomingMessage, res: ServerResponse): void {
  let head = '';
  let done = false;
  appRes.setEncoding('utf8');
  appRes.on('data', (chunk: string) => {
    if (done) {
      res.write(chunk);
      return;
    }
    head += chunk;
    if (/<head(\s[^>]*)?>/i.test(head) || head.length > 65_536) {
      done = true;
      res.write(injectPicker(head, PICKER_EXTERNAL));
    }
  });
  appRes.on('end', () => {
    if (!done) res.write(injectPicker(head, PICKER_EXTERNAL));
    res.end();
  });
}
