// Built-in browser (PM-253, docs/BUILT-IN-BROWSER.md): a GET-only reverse proxy to a dev server on
// this computer's loopback, so a phone or the remote listener can see `localhost` apps.
//  - The target host is always 127.0.0.1; only the port comes from the request.
//  - The app's own ports are refused, so the proxy can't loop back into the API.
//  - Cookies and credentials never cross in either direction.
//  - Redirects are not followed: a Location is rewritten back under the proxy, or refused.
//  - Framing is limited to this app, and the page must be shown in a sandboxed iframe without
//    `allow-same-origin` (the client's job), so it can't act as the app's origin.

export class PreviewError extends Error {
  constructor(
    public status: 400 | 403 | 502 | 504,
    message: string,
  ) {
    super(message);
  }
}

const MIN_PORT = 1024;
const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 25 * 1024 * 1024;

/** A usable preview port, or throws. `blocked` holds the app's own listener ports. */
export function parsePreviewPort(value: string, blocked: ReadonlySet<number>): number {
  if (!/^\d{1,5}$/.test(value)) throw new PreviewError(400, 'Port must be a number');
  const port = Number(value);
  if (port < MIN_PORT || port > 65535) {
    throw new PreviewError(400, `Port must be between ${MIN_PORT} and 65535`);
  }
  if (blocked.has(port)) throw new PreviewError(403, "That port is ProjectManager's own");
  return port;
}

/** Where a redirect from the page should go instead, or null when it must be refused. */
export function rewriteLocation(location: string, port: number): string | null {
  const prefix = `/api/preview/${port}`;
  if (location.startsWith('//')) return null;
  if (location.startsWith('/')) return `${prefix}${location}`;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(location)) return location; // relative: stays under the prefix
  try {
    const url = new URL(location);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol === 'http:' && loopback && Number(url.port || 80) === port) {
      return `${prefix}${url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // Malformed: refuse below.
  }
  return null;
}

/** Root-absolute URLs in markup point at this app, not the page; send them through the proxy. */
export function rewriteHtml(html: string, port: number): string {
  const prefix = `/api/preview/${port}`;
  return html.replace(
    /(\s(?:src|href|action|poster)\s*=\s*)(["'])\/(?!\/)/gi,
    (_all, attr: string, quote: string) => `${attr}${quote}${prefix}/`,
  );
}

const DROP_REQUEST = new Set([
  'host',
  'cookie',
  'authorization',
  'origin',
  'referer',
  'connection',
  'content-length',
  'upgrade',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-pm-lan',
  'x-pm-remote',
  'cf-access-jwt-assertion',
]);
const DROP_RESPONSE = new Set([
  'set-cookie',
  'x-frame-options',
  'content-security-policy',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
]);

/** Fetches `<path><search>` from the dev server on `port`. Only GET and HEAD are allowed. */
export async function proxyPreview(
  request: Request,
  port: number,
  path: string,
  search: string,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new PreviewError(403, 'The preview is read-only: only GET and HEAD');
  }
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!DROP_REQUEST.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set('accept-encoding', 'identity');
  const target = `http://127.0.0.1:${port}${path.startsWith('/') ? path : `/${path}`}${search}`;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw timedOut
      ? new PreviewError(504, `Nothing answered on port ${port} in time`)
      : new PreviewError(502, `Nothing is listening on port ${port}`);
  }

  const out = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!DROP_RESPONSE.has(name.toLowerCase())) out.set(name, value);
  }
  const location = upstream.headers.get('location');
  if (location) {
    const rewritten = rewriteLocation(location, port);
    if (!rewritten) throw new PreviewError(403, 'The page redirected somewhere other than itself');
    out.set('location', rewritten);
  }
  out.set('content-security-policy', "frame-ancestors 'self'");
  out.set('x-content-type-options', 'nosniff');
  out.set('cache-control', 'no-store');

  const type = upstream.headers.get('content-type') ?? '';
  if (request.method === 'HEAD' || upstream.status === 204 || upstream.status === 304) {
    return new Response(null, { status: upstream.status, headers: out });
  }
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw new PreviewError(502, 'The page is too large');
  if (/^text\/html\b/i.test(type)) {
    const html = rewriteHtml(new TextDecoder().decode(bytes), port);
    return new Response(html, { status: upstream.status, headers: out });
  }
  return new Response(bytes, { status: upstream.status, headers: out });
}
