#!/usr/bin/env node
// Owner Pages: the pages the owner reads, built into the git-ignored `References/owner-pages/`.
//
//   npm run owner:pages           write index.html and owner-desk.html from owner-desk.json
//   npm run owner:pages -- --init write an empty owner-desk.json to start from
//   npm run owner:pages -- --check validate owner-desk.json and print the counts, write nothing
//
// The Owner Desk lists work only a person can do: accounts, credentials, approvals, real-device
// checks and decisions. Its data is `References/owner-pages/owner-desk.json`. That file stays local
// (References is git-ignored; ProjectManager's repository is public and the desk names the owner's
// own accounts and devices), so unlike the standard's tracked data this one is local: see the
// deviation recorded in CLAUDE.md. The generator, the schema and the design are tracked here.
//
// The pages use ProjectManager's design tokens (client/src/styles.css, DESIGN.md) in both themes
// through one shared shell, work opened straight from the filesystem, and need no server.
// QA scorecard and feature-parity pages are not generated: those grade offerings built on existing
// products, and ProjectManager has none.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { staticDesk } from './owner-pages-static.mjs';

export const STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Completed', 'Not Applicable'];
export const PRIORITIES = ['High', 'Medium', 'Low'];
const OPEN = new Set(['Not Started', 'In Progress', 'Blocked']);
/** The key the owner's ticks were kept under; a page built before this one kept none. */
export const TICKS_KEY = 'pm.owner-desk.ticks';

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Escaped text with http(s) addresses made into links (the only markup a field can carry). */
export function linkify(value) {
  return esc(value).replace(
    /https?:\/\/[^\s<]+[^\s<.,;:)'"]/g,
    (url) => `<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`,
  );
}

/** Problems with the desk data, as readable lines (empty when it is fine). */
export function validateDesk(data) {
  const problems = [];
  if (!data || typeof data !== 'object' || !Array.isArray(data.tasks))
    return ['The file must be an object with a "tasks" array'];
  const seen = new Set();
  data.tasks.forEach((task, i) => {
    const at = `Task ${i + 1}${task?.id ? ` (${task.id})` : ''}`;
    for (const key of ['id', 'title', 'category', 'priority', 'status', 'why', 'accept'])
      if (typeof task?.[key] !== 'string' || !task[key].trim())
        problems.push(`${at}: "${key}" is missing`);
    if (task?.id && seen.has(task.id)) problems.push(`${at}: the id is used twice`);
    seen.add(task?.id);
    if (task?.status && !STATUSES.includes(task.status))
      problems.push(`${at}: status must be one of ${STATUSES.join(', ')}`);
    if (task?.priority && !PRIORITIES.includes(task.priority))
      problems.push(`${at}: priority must be one of ${PRIORITIES.join(', ')}`);
    if (!Array.isArray(task?.steps) || task.steps.some((s) => typeof s !== 'string'))
      problems.push(`${at}: "steps" must be a list of text`);
    if (task?.status === 'Completed' && !String(task.evidence ?? '').trim())
      problems.push(`${at}: a Completed task needs "evidence" (what showed it was done)`);
  });
  return problems;
}

/** Tasks still waiting on the owner. */
export const isOpen = (task) => OPEN.has(task.status);

export function summary(tasks) {
  const count = (status) => tasks.filter((t) => t.status === status).length;
  return {
    pending: tasks.filter((t) => t.status === 'Not Started' || t.status === 'In Progress').length,
    blocked: count('Blocked'),
    completed: count('Completed'),
    blocking: tasks.filter((t) => t.blocking && isOpen(t)).length,
    total: tasks.length,
  };
}

// ---- the shared shell: ProjectManager's tokens, both themes, one stylesheet --------------------

const TOKENS = `
:root {
  color-scheme: light;
  --font-sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --font-mono: ui-monospace, 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace;
  --bg: #e9e8e3; --surface: #f3f2ee; --surface-2: #eae9e4; --surface-hover: #e3e2dc;
  --border: #d8d6cf; --border-strong: #c4c2ba;
  --text: #0b0b0b; --text-2: #4d4c49; --text-3: #6e6d68;
  --accent: #2a78d6; --accent-text: #ffffff; --accent-soft: #dde8f7;
  --danger: #d03b3b; --danger-soft: #f5e1e0; --good: #0ca30c; --warn: #eda100; --focus: #2a78d6;
  --radius-sm: 4px; --radius: 8px; --radius-lg: 12px;
  --shadow: 0 1px 2px rgb(0 0 0 / 0.05), 0 1px 3px rgb(0 0 0 / 0.06);
}
:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #121211; --surface: #1a1a19; --surface-2: #232321; --surface-hover: #2a2a28;
  --border: #2e2e2b; --border-strong: #3d3d39;
  --text: #e4e3dd; --text-2: #a8a79f; --text-3: #86857d;
  --accent: #7fa8e0; --accent-text: #10161f; --accent-soft: #1d2633;
  --danger: #e0807c; --danger-soft: #3a1d1d; --good: #3fbf3f; --warn: #c98500; --focus: #96b8e7;
  --shadow: 0 1px 2px rgb(0 0 0 / 0.4);
}`;

const SHELL_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 var(--font-sans); }
a { color: var(--accent); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.topbar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--surface);
  border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 5; }
.topbar a.brand { color: var(--text); font-weight: 650; text-decoration: none; }
.topbar nav { display: flex; gap: 4px; flex: 1; flex-wrap: wrap; }
.topbar nav a { padding: 4px 10px; border-radius: 999px; color: var(--text-2); text-decoration: none; font-weight: 550; }
.topbar nav a[aria-current='page'] { background: var(--accent-soft); color: var(--text); }
.topbar nav a:hover { background: var(--surface-hover); }
button, select, input { font: inherit; color: var(--text); }
.btn { padding: 4px 12px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  background: var(--surface); cursor: pointer; }
.btn:hover { background: var(--surface-hover); }
main { max-width: 920px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { margin: 0 0 4px; font-size: 24px; letter-spacing: -0.01em; }
.lede, .note, .meta, .empty { color: var(--text-2); }
.note { font-size: 13px; max-width: 70ch; }
.tiles { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 16px; min-width: 110px; }
.tile b { display: block; font-size: 22px; line-height: 1.2; }
.tile.alert { border-color: var(--danger); background: var(--danger-soft); }
.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin: 8px 0 4px; }
.filters label { display: grid; gap: 2px; font-size: 12px; color: var(--text-3); }
.filters select, .filters input { padding: 5px 8px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); }
.task { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; margin: 12px 0; box-shadow: var(--shadow); }
.task.blocking { border-color: var(--danger); }
.task.done h3 { text-decoration: line-through; color: var(--text-3); }
.task h3 { margin: 0 0 4px; font-size: 15px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.task .tick { margin-right: 4px; width: 16px; height: 16px; accent-color: var(--accent); }
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 650; background: var(--surface-2); color: var(--text-2); }
.chip.blk { background: var(--danger); color: #fff; }
.chip.st-Completed { background: var(--good); color: #fff; }
.chip.st-Blocked { background: var(--danger-soft); color: var(--danger); }
.chip.st-In\\ Progress { background: var(--accent-soft); color: var(--accent); }
.meta { font-size: 12.5px; }
.task p { margin: 8px 0; } .task ol { margin: 4px 0 8px; padding-left: 22px; }
.task dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 8px 0 0; font-size: 13px; }
.task dt { color: var(--text-3); } .task dd { margin: 0; }
.evidence { border-left: 3px solid var(--good); padding: 2px 10px; background: var(--surface-2); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; font-size: 13px; }
.empty { padding: 24px; text-align: center; border: 1px dashed var(--border-strong); border-radius: var(--radius); }
a.card { display: block; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg);
  padding: 14px 16px; margin: 12px 0; color: inherit; text-decoration: none; box-shadow: var(--shadow); }
a.card:hover { border-color: var(--border-strong); background: var(--surface-hover); }
a.card b { color: var(--accent); font-size: 16px; }
.na { color: var(--text-3); }
code { font-family: var(--font-mono); font-size: 12.5px; background: var(--surface-2); padding: 1px 5px; border-radius: var(--radius-sm); }
@media (max-width: 560px) { .task dl { grid-template-columns: 1fr; } .task dt { margin-top: 6px; } }
@media print { .topbar, .filters { display: none; } }`;

/** The theme choice is kept in this browser, and is set before first paint so nothing flashes. */
const THEME_BOOT = `try{var t=localStorage.getItem('pm.owner-pages.theme');if(!t)t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='light'}`;

const THEME_TOGGLE = `<button class="btn" id="theme" type="button" aria-label="Switch between the light and dark theme">Theme</button>
<script>document.getElementById('theme').addEventListener('click',function(){var d=document.documentElement,n=d.dataset.theme==='dark'?'light':'dark';d.dataset.theme=n;try{localStorage.setItem('pm.owner-pages.theme',n)}catch(e){}})</script>`;

function shell({ title, current, body, script = '' }) {
  const link = (href, label, key) =>
    `<a href="${href}"${current === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<script>${THEME_BOOT}</script>
<style>${TOKENS}${SHELL_CSS}</style>
</head>
<body>
<header class="topbar"><a class="brand" href="index.html">ProjectManager</a>
<nav aria-label="Owner pages">${link('index.html', 'Owner pages', 'index')}${link('owner-desk.html', 'Owner desk', 'desk')}</nav>
${THEME_TOGGLE}</header>
<main>${body}</main>
${script}
</body>
</html>
`;
}

export function renderIndex({ updated = '', counts } = {}) {
  const open = counts
    ? ` ${counts.pending} pending, ${counts.blocked} blocked, ${counts.completed} completed.`
    : '';
  return shell({
    title: 'ProjectManager owner pages',
    current: 'index',
    body: `<h1>Owner pages</h1>
<p class="lede">What ProjectManager needs from you, in one place. Local only: this folder is git-ignored.${updated ? ` Built ${esc(updated)}.` : ''}</p>
<a class="card" href="owner-desk.html"><b>Owner desk</b><br>Every action only you can take, with exact steps and what done looks like.${esc(open)}</a>
<a class="card" href="../../README.md"><b>Readme</b><br>What this project is, how to run it, and where things live (README.md in the project root).</a>
<a class="card" href="../../ROADMAP.md"><b>Roadmap</b><br>Vision, scope, phases with exit criteria, and risks (ROADMAP.md in the project root).</a>
<p class="na">QA scorecard and Feature parity are not built: they grade offerings based on existing products, and ProjectManager has none yet.</p>
<p class="note">Rebuild with <code>npm run owner:pages</code>. The agent edits <code>owner-desk.json</code>; ticks you make on the desk are kept in this browser only.</p>`,
  });
}

/** The page script: filters, summary, and the owner's ticks, from the data embedded in the page. */
const DESK_SCRIPT = `<script>
const TASKS = __TASKS__;
const TICKS_KEY = '${TICKS_KEY}';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const linkify = (s) => esc(s).replace(/https?:\\/\\/[^\\s<]+[^\\s<.,;:)'"]/g, (u) => '<a href="' + u + '" target="_blank" rel="noreferrer noopener">' + u + '</a>');
const OPEN = ['Not Started', 'In Progress', 'Blocked'];
const open = (t) => OPEN.includes(t.status);
let ticks = {};
try { ticks = JSON.parse(localStorage.getItem(TICKS_KEY) || '{}') || {}; } catch (e) { ticks = {}; }
const saveTicks = () => { try { localStorage.setItem(TICKS_KEY, JSON.stringify(ticks)); } catch (e) {} };
function fill(id, values) { const el = $(id); [...new Set(values)].filter((v) => ![...el.options].some((o) => o.value === v)).forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; el.appendChild(o); }); }
fill('fs', TASKS.map((t) => t.status)); fill('fp', TASKS.map((t) => t.priority)); fill('fc', TASKS.map((t) => t.category));
function draw() {
  const fs = $('fs').value, fp = $('fp').value, fc = $('fc').value, q = $('q').value.trim().toLowerCase();
  const count = (s) => TASKS.filter((t) => t.status === s).length;
  const blocking = TASKS.filter((t) => t.blocking && open(t)).length;
  $('tiles').innerHTML =
    '<div class="tile"><b>' + TASKS.filter((t) => t.status === 'Not Started' || t.status === 'In Progress').length + '</b>Pending</div>' +
    '<div class="tile"><b>' + count('Blocked') + '</b>Blocked</div>' +
    '<div class="tile"><b>' + count('Completed') + '</b>Completed</div>' +
    '<div class="tile' + (blocking ? ' alert' : '') + '"><b>' + blocking + '</b>Blocking the agent</div>';
  const shown = TASKS.filter((t) => (!fs || t.status === fs) && (!fp || t.priority === fp) && (!fc || t.category === fc) &&
      (!q || (t.id + ' ' + t.title + ' ' + t.steps.join(' ') + ' ' + t.why).toLowerCase().includes(q)))
    .sort((a, b) => (b.blocking && open(b)) - (a.blocking && open(a)));
  $('list').innerHTML = !TASKS.length
    ? '<p class="empty">Nothing needs you right now. The agent adds a task here when it genuinely needs you: an account, a credential, an approval, a real-device check or a decision.</p>'
    : !shown.length ? '<p class="empty">No tasks match these filters.</p>' : shown.map((t) => {
      const isBlocking = t.blocking && open(t);
      const row = (k, v) => v ? '<dt>' + k + '</dt><dd>' + linkify(v) + '</dd>' : '';
      return '<section class="task' + (isBlocking ? ' blocking' : '') + (ticks[t.id] ? ' done' : '') + '" id="' + esc(t.id) + '">' +
        '<h3><input class="tick" type="checkbox" data-id="' + esc(t.id) + '"' + (ticks[t.id] ? ' checked' : '') + ' aria-label="Mark ' + esc(t.id) + ' done on this page">' +
        esc(t.id) + ' \\u00b7 ' + esc(t.title) + (isBlocking ? ' <span class="chip blk">BLOCKING</span>' : '') +
        ' <span class="chip st-' + esc(t.status) + '">' + esc(t.status) + '</span></h3>' +
        '<div class="meta">' + esc(t.category) + ' \\u00b7 Priority ' + esc(t.priority) + ' \\u00b7 Created ' + esc(t.created) + ', updated ' + esc(t.updated) + '</div>' +
        '<p><b>Why it needs you:</b> ' + linkify(t.why) + '</p>' +
        (t.steps.length ? '<b>Steps</b><ol>' + t.steps.map((s) => '<li>' + linkify(s) + '</li>').join('') + '</ol>' : '') +
        (t.evidence ? '<p class="evidence"><b>Evidence:</b> ' + linkify(t.evidence) + '</p>' : '') +
        '<dl>' + row('Depends on', t.deps) + row('Links', t.links) + row('Done when', t.accept) + row('Agent continues with', t.agent) + '</dl></section>';
    }).join('');
}
['fs', 'fp', 'fc'].forEach((id) => $(id).addEventListener('change', draw));
$('q').addEventListener('input', draw);
$('list').addEventListener('change', (e) => {
  const box = e.target.closest('input.tick'); if (!box) return;
  if (box.checked) ticks[box.dataset.id] = true; else delete ticks[box.dataset.id];
  saveTicks(); draw();
});
draw();
</script>`;

export function renderDesk(data, { updated = '' } = {}) {
  const tasks = data.tasks.map((t) => ({ ...t, steps: t.steps ?? [] }));
  // "</" inside the data must not end the script early.
  const json = JSON.stringify(tasks).replace(/</g, '\\u003c');
  return shell({
    title: 'ProjectManager owner desk',
    current: 'desk',
    body: `<h1>Owner desk</h1>
<p class="lede">Work only you can do: accounts, credentials, approvals, real-device checks and decisions.</p>
<p class="note">Statuses come from <code>owner-desk.json</code>, which the agent keeps up to date; changing one in the browser does not save it there. The ticks are only your own marker and are kept in this browser. Nothing here holds a secret.${updated ? ` Built ${esc(updated)}.` : ''}</p>
<div class="tiles" id="tiles" aria-live="polite"></div>
<div class="filters">
<label>Status <select id="fs"><option value="">All</option></select></label>
<label>Priority <select id="fp"><option value="">All</option></select></label>
<label>Category <select id="fc"><option value="">All</option></select></label>
<label>Search <input id="q" type="search" placeholder="Title, steps or reason"></label>
</div>
<div id="list"></div>`,
    // A function, so "$&" or "$1" inside a task's text is data, not a replacement pattern.
    script: DESK_SCRIPT.replace('__TASKS__', () => json),
  });
}

// ---- command line -----------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

export function run(argv = process.argv.slice(2), rootDir = root, log = console.log) {
  const outDir = join(rootDir, 'References', 'owner-pages');
  const dataFile = join(outDir, 'owner-desk.json');
  if (argv.includes('--init')) {
    if (existsSync(dataFile)) return (log(`${dataFile} already exists; left as it is.`), 0);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      dataFile,
      JSON.stringify({ project: 'ProjectManager', tasks: [] }, null, 2) + '\n',
    );
    return (log(`Wrote an empty ${dataFile}`), 0);
  }
  if (!existsSync(dataFile)) {
    log(`No ${dataFile}. Run "npm run owner:pages -- --init" to start an empty desk.`);
    return 1;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(dataFile, 'utf8'));
  } catch (error) {
    log(`owner-desk.json is not valid JSON: ${error.message}`);
    return 1;
  }
  if (!existsSync(join(rootDir, 'ROADMAP.md'))) {
    log(
      'ROADMAP.md is missing from the project root. The roadmap is part of the owner pages (standard, PM-289).',
    );
    return 1;
  }
  const problems = validateDesk(data);
  if (problems.length) {
    log(`owner-desk.json has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
    return 1;
  }
  const counts = summary(data.tasks);
  if (argv.includes('--check')) {
    log(
      `owner-desk.json is valid: ${counts.total} tasks, ${counts.pending} pending, ${counts.blocked} blocked, ${counts.completed} completed.`,
    );
    return 0;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'owner-desk.html'),
    staticDesk(renderDesk(data, { updated: stamp })) ?? renderDesk(data, { updated: stamp }),
  );
  writeFileSync(join(outDir, 'index.html'), renderIndex({ updated: stamp, counts }));
  log(`Wrote ${join(outDir, 'index.html')} and owner-desk.html (${counts.total} tasks).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run();
}
