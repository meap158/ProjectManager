#!/usr/bin/env node
// Fills a built Owner desk with its tasks as plain HTML, so the page shows them in a viewer that
// does not run scripts (a preview pane, a sandboxed frame, a text export). The page's own script
// redraws the same list as soon as it runs, so nothing else changes.
//
//   node scripts/owner-pages-static.mjs <project folder> [<project folder> ...]
//
// Reads the tasks out of References/owner-pages/owner-desk.html (the TASKS array every project's
// generator embeds), so it works with each project's own generator. Run it after `owner-pages`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const linkify = (value) =>
  esc(value).replace(
    /https?:\/\/[^\s<]+[^\s<.,;:)'"]/g,
    (url) => `<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`,
  );
const OPEN = new Set(['Not Started', 'In Progress', 'Blocked']);

export function staticDesk(html) {
  const found = /const TASKS = (\[[\s\S]*?\]);\r?\n/.exec(html);
  if (!found || !html.includes('<div id="list"></div>') || !html.includes('id="tiles"'))
    return null;
  const tasks = JSON.parse(found[1]);
  const count = (status) => tasks.filter((t) => t.status === status).length;
  const blocking = tasks.filter((t) => t.blocking && OPEN.has(t.status)).length;
  const pending = tasks.filter(
    (t) => t.status === 'Not Started' || t.status === 'In Progress',
  ).length;
  const tiles =
    `<div class="tile"><b>${pending}</b>Pending</div><div class="tile"><b>${count('Blocked')}</b>Blocked</div>` +
    `<div class="tile"><b>${count('Completed')}</b>Completed</div>` +
    `<div class="tile${blocking ? ' alert' : ''}"><b>${blocking}</b>Blocking the agent</div>`;
  const row = (k, v) => (v ? `<dt>${k}</dt><dd>${linkify(v)}</dd>` : '');
  const list = tasks.length
    ? [...tasks]
        .sort((a, b) => (b.blocking && OPEN.has(b.status)) - (a.blocking && OPEN.has(a.status)))
        .map((t) => {
          const isBlocking = t.blocking && OPEN.has(t.status);
          return (
            `<section class="task${isBlocking ? ' blocking' : ''}" id="${esc(t.id)}"><h3>${esc(t.id)} · ${esc(t.title)}` +
            `${isBlocking ? ' <span class="chip blk">BLOCKING</span>' : ''} <span class="chip st-${esc(t.status)}">${esc(t.status)}</span></h3>` +
            `<div class="meta">${esc(t.category)} · Priority ${esc(t.priority)} · Created ${esc(t.created)}, updated ${esc(t.updated)}</div>` +
            `<p><b>Why it needs you:</b> ${linkify(t.why)}</p>` +
            ((t.steps ?? []).length
              ? `<b>Steps</b><ol>${t.steps.map((s) => `<li>${linkify(s)}</li>`).join('')}</ol>`
              : '') +
            (t.evidence ? `<p class="evidence"><b>Evidence:</b> ${linkify(t.evidence)}</p>` : '') +
            `<dl>${row('Depends on', t.deps)}${row('Links', t.links)}${row('Done when', t.accept)}${row('Agent continues with', t.agent)}</dl></section>`
          );
        })
        .join('')
    : '<p class="empty">Nothing needs you right now.</p>';
  // The filter menus are filled by the page's script too. Fill them here so they list their
  // values in a viewer that does not run it, and make the script skip values already present.
  const options = (id, key) => {
    const values = [...new Set(tasks.map((t) => t[key]))];
    return (page) =>
      page.replace(
        new RegExp(`(<select id="${id}"><option value="">All</option>)(</select>)`),
        `$1${values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}$2`,
      );
  };
  const idempotent = (page) =>
    page.replace(
      '[...new Set(values)].forEach((v) => {',
      '[...new Set(values)].filter((v) => ![...el.options].some((o) => o.value === v)).forEach((v) => {',
    );
  return [
    options('fs', 'status'),
    options('fp', 'priority'),
    options('fc', 'category'),
    idempotent,
  ].reduce(
    (page, step) => step(page),
    html
      .replace(/(<div class="tiles" id="tiles"[^>]*>)<\/div>/, `$1${tiles}</div>`)
      .replace('<div id="list"></div>', `<div id="list">${list}</div>`),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const folder of process.argv.slice(2)) {
    const file = join(folder, 'References', 'owner-pages', 'owner-desk.html');
    if (!existsSync(file)) {
      console.log(`${folder}: no owner-desk.html`);
      continue;
    }
    const next = staticDesk(readFileSync(file, 'utf8'));
    if (!next) {
      console.log(`${folder}: layout not recognised, left as it was`);
      continue;
    }
    writeFileSync(file, next);
    console.log(`${folder}: tasks written into the page`);
  }
}
