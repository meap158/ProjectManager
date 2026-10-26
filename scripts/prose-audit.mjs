#!/usr/bin/env node
// Prose audit (PM-314): finds the mechanical tells of machine-written text in a project, so the
// writing rule in AGENTS.md can be enforced the same way in every project.
//
//   node scripts/prose-audit.mjs [dir]           count tells per file in the project's prose (.md, .txt)
//   node scripts/prose-audit.mjs [dir] --list    also print each line
//   node scripts/prose-audit.mjs [dir] --diff    check only lines added since HEAD (staged and
//                                                unstaged) in any text file; exit 1 if there are any
//
// Read-only. It looks for the tells a pattern can catch (em dashes, stock phrases and words,
// chatbot residue, decorative emoji in headings). Judgement tells such as forced triads or "not X
// but Y" stay with the writer: see https://github.com/blader/humanizer. Existing text is never a
// failure, so a project adopts the rule without a mass rewrite; `--diff` keeps new text clean.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Each tell: a name and a pattern that matches one occurrence on a line. */
export const TELLS = [
  { id: 'em-dash', re: /—/ },
  { id: 'spaced-en-dash', re: / – / },
  {
    id: 'stock-word',
    re: /\b(delve[sd]?|tapestry|testament to|pivotal|seamless(?:ly)?|showcas(?:e|es|ing)|underscor(?:e|es|ing)|vibrant|nestled|breathtaking|meticulous(?:ly)?)\b/i,
  },
  {
    id: 'stock-phrase',
    re: /\b(at its core|let'?s dive in|here'?s the thing|let that sink in|game[- ]changer|in today'?s (?:fast-paced|digital)|it'?s worth noting that|serves as a|stands as a)\b/i,
  },
  {
    id: 'not-x-but-y',
    re: /\bnot (?:just|only|merely) [^.;:]{1,60}, (?:but )?(?:it'?s|it is|but)\b/i,
  },
  {
    id: 'chatbot-residue',
    re: /\b(great question|i hope this helps|certainly!|as an ai\b|feel free to ask)/i,
  },
  { id: 'emoji-heading', re: /^#{1,6}\s*[\u{1F300}-\u{1FAFF}☀-➿]/u },
];

/**
 * Tells on one line. `inFence` lines (code in a markdown block) are skipped by the caller.
 * @param {string} line
 * @returns {string[]} ids of the tells found, in TELLS order
 */
export function tellsInLine(line) {
  return TELLS.filter((t) => t.re.test(line)).map((t) => t.id);
}

/** Tells in a markdown or text body, leaving fenced code alone. */
export function scanText(text) {
  const hits = [];
  let fenced = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const id of tellsInLine(line)) hits.push({ line: i + 1, id, text: line.trim() });
  });
  return hits;
}

/** The lines a unified diff adds, per file. Hunk headers give the new line number. */
export function addedLines(diff) {
  const out = [];
  let file = '';
  let n = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) file = raw.slice(4).replace(/^b\//, '');
    else if (raw.startsWith('@@')) n = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0) - 1;
    else if (raw.startsWith('+') && !raw.startsWith('+++')) {
      n += 1;
      out.push({ file, line: n, text: raw.slice(1) });
    } else if (!raw.startsWith('-') && !raw.startsWith('\\')) n += 1;
  }
  return out;
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });

const PROSE = /\.(md|txt)$/;

export function run(argv, log = console.log) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const dir = argv.find((a) => !a.startsWith('--')) ?? process.cwd();
  if (flags.includes('--diff')) {
    const added = addedLines(git(dir, ['diff', 'HEAD', '--unified=0', '--no-color']));
    const found = added.flatMap((a) => tellsInLine(a.text).map((id) => ({ ...a, id })));
    for (const f of found) log(`${f.file}:${f.line} ${f.id}: ${f.text.slice(0, 120)}`);
    log(
      found.length ? `${found.length} new tell(s). Rewrite them.` : 'No new tells in added lines.',
    );
    return found.length ? 1 : 0;
  }
  const files = git(dir, ['ls-files'])
    .split('\n')
    .filter((f) => PROSE.test(f));
  const totals = {};
  for (const f of files) {
    let hits;
    try {
      hits = scanText(readFileSync(join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!hits.length) continue;
    for (const h of hits) totals[h.id] = (totals[h.id] ?? 0) + 1;
    log(`${f}: ${hits.length}`);
    if (flags.includes('--list'))
      for (const h of hits) log(`  ${h.line} ${h.id}: ${h.text.slice(0, 120)}`);
  }
  log(`Totals: ${JSON.stringify(totals)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run(process.argv.slice(2)));
}
