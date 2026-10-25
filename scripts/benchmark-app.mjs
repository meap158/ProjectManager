// App-wide performance benchmark (docs/PERFORMANCE.md): the client bundle a first visit downloads
// and the latency of the read endpoints the pages load. Read-only: GET requests only, and the
// bundle is built in memory (nothing written, a running dev server untouched).
//
//   node scripts/benchmark-app.mjs                 both, against http://127.0.0.1:5180
//   node scripts/benchmark-app.mjs --api --url http://127.0.0.1:5181 --runs 30
//   node scripts/benchmark-app.mjs --bundle --out docs/perf/after.json
//   node scripts/benchmark-app.mjs --api --only agent-sessions,cards   endpoints containing these
//   node scripts/benchmark-app.mjs --stalls 60      event-loop stalls: a trivial read every 50 ms
import { writeFileSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const both = !flag('api') && !flag('bundle') && !flag('stalls');
const base = option('url', 'http://127.0.0.1:5180').replace(/\/$/, '');
const runs = Number(option('runs', '20'));
const result = { at: new Date().toISOString(), node: process.version };

// The endpoints the pages read on load (Dashboard, Board, Agents, Orchestrators, Settings).
const ENDPOINTS = [
  '/api/projects',
  '/api/agent-sessions',
  '/api/cards',
  '/api/cards/in-flight',
  '/api/agent-limits',
  '/api/agent-runs',
  '/api/orchestrators',
  '/api/orchestrators/overview',
  '/api/agents/providers',
  '/api/agents/sensors',
  '/api/agents/codex-accounts',
  '/api/workspace',
  '/api/preview-launches',
  // One project's page (this repository's own entry, id 14 here; --project to change it).
  ...[
    '',
    '/cards',
    '/agent-sessions',
    '/agent-runs/summary',
    '/file-pins',
    '/git-identity',
    '/tree?path=',
    '/pull-requests?state=open',
  ].map((tail) => `/api/projects/${option('project', '14')}${tail}`),
];

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const round = (n) => Math.round(n * 10) / 10;

async function benchApi() {
  const rows = [];
  const only = option('only', '').split(',').filter(Boolean);
  for (const path of ENDPOINTS.filter((p) => !only.length || only.some((o) => p.endsWith(o)))) {
    const times = [];
    let body = Buffer.alloc(0);
    let wire = 0;
    let encoding = null;
    let status = 0;
    for (let i = 0; i < runs + 2; i++) {
      const started = performance.now();
      // Ask for compression like a browser does; fetch decodes it, so measure the wire size
      // from the header (absent when the server sent it uncompressed).
      const res = await fetch(base + path, { headers: { 'accept-encoding': 'gzip, br' } });
      const buf = Buffer.from(await res.arrayBuffer());
      const ms = performance.now() - started;
      status = res.status;
      encoding = res.headers.get('content-encoding');
      wire = Number(res.headers.get('content-length')) || 0;
      body = buf;
      if (i >= 2) times.push(ms); // The first two warm caches and connections.
    }
    times.sort((a, b) => a - b);
    // A poll of an unchanged list: the browser revalidates with the ETag it was given.
    let revalidate = null;
    const etag = (await fetch(base + path, { method: 'GET' })).headers.get('etag');
    if (etag) {
      const started = performance.now();
      const res = await fetch(base + path, { headers: { 'if-none-match': etag } });
      const bytes = (await res.arrayBuffer()).byteLength;
      revalidate = { status: res.status, ms: round(performance.now() - started), bytes };
    }
    rows.push({
      path,
      status,
      medianMs: round(percentile(times, 0.5)),
      p95Ms: round(percentile(times, 0.95)),
      bytes: body.length,
      encoding,
      wireBytes: encoding ? wire || null : body.length,
      gzipBytes: gzipSync(body).length,
      revalidate,
    });
  }
  return rows;
}

async function benchBundle() {
  process.env.NODE_ENV = 'production';
  const { build } = await import('vite');
  const { output } = await build({ logLevel: 'error', build: { write: false } });
  const chunks = output.filter((item) => item.type === 'chunk');
  const entry = chunks.find((item) => item.isEntry);
  const initial = new Set();
  const visit = (name) => {
    if (initial.has(name)) return;
    initial.add(name);
    for (const dep of chunks.find((c) => c.fileName === name)?.imports ?? []) visit(dep);
  };
  visit(entry.fileName);
  const size = (code) => ({
    bytes: Buffer.byteLength(code),
    gzip: gzipSync(code).length,
    brotli: brotliCompressSync(code).length,
  });
  const sum = (items) =>
    items.reduce(
      (n, item) => {
        const s = size(item.code ?? item.source);
        return { bytes: n.bytes + s.bytes, gzip: n.gzip + s.gzip, brotli: n.brotli + s.brotli };
      },
      { bytes: 0, gzip: 0, brotli: 0 },
    );
  const css = output.filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'));
  const initialChunks = chunks.filter((c) => initial.has(c.fileName));
  return {
    initialJs: sum(initialChunks),
    initialChunks: initialChunks.map((c) => c.fileName),
    // CSS the entry pulls in (the rest arrives with lazy routes).
    css: sum(css),
    totalJs: sum(chunks),
    chunkCount: chunks.length,
    largest: chunks
      .map((c) => ({ file: c.fileName, ...size(c.code) }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 8),
  };
}

/**
 * Background work (timers) blocks every request and terminal stream while it runs. A trivial
 * read every 50 ms shows it: its latency jumps whenever a tick holds the event loop.
 */
async function benchStalls(seconds) {
  const lat = [];
  const spikes = [];
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    const started = performance.now();
    await fetch(base + '/api/agent-runs').then((r) => r.arrayBuffer());
    const ms = performance.now() - started;
    lat.push(ms);
    if (ms > 50) spikes.push({ at: new Date().toISOString().slice(11, 19), ms: Math.round(ms) });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  lat.sort((a, b) => a - b);
  return {
    seconds,
    samples: lat.length,
    p50Ms: round(percentile(lat, 0.5)),
    p99Ms: round(percentile(lat, 0.99)),
    maxMs: Math.round(lat.at(-1)),
    over50ms: spikes.length,
    spikes,
  };
}

if (both || flag('bundle')) result.bundle = await benchBundle();
if (flag('stalls')) result.stalls = await benchStalls(Number(option('stalls', '60')) || 60);
if (both || flag('api')) result.api = await benchApi();
const json = JSON.stringify(result, null, 2);
const out = option('out', null);
if (out) writeFileSync(out, json + '\n');
console.log(json);
