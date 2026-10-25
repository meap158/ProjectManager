import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  isOpen,
  linkify,
  renderDesk,
  renderIndex,
  run,
  summary,
  validateDesk,
} from '../scripts/owner-pages.mjs';

// Owner Pages (PM-258): the Owner desk is built from owner-desk.json by a tracked generator.
// The data is local and may hold any text, so it must never become markup, and a bad file must
// be refused with a readable reason instead of writing a broken page.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'pm-owner-pages-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const task = (patch: Record<string, unknown> = {}) => ({
  id: 'DT-001',
  title: 'Restart the server',
  category: 'Operations',
  priority: 'High',
  status: 'Not Started',
  why: 'Only the owner can pick a quiet moment.',
  steps: ['Restart through the launcher.'],
  accept: 'The new build is running.',
  created: '2026-10-25',
  updated: '2026-10-25',
  ...patch,
});

describe('validateDesk', () => {
  it('accepts a well-formed desk, and an empty one', () => {
    expect(validateDesk({ tasks: [task()] })).toEqual([]);
    expect(validateDesk({ tasks: [] })).toEqual([]);
  });

  it('says what is wrong, task by task', () => {
    const problems = validateDesk({
      tasks: [
        task({ id: 'DT-001' }),
        task({ id: 'DT-001', status: 'Done', priority: 'Urgent' }),
        task({ id: 'DT-003', title: '', steps: 'restart' }),
        task({ id: 'DT-004', status: 'Completed' }),
      ],
    });
    const text = problems.join('\n');
    expect(text).toMatch(/DT-001\): the id is used twice/);
    expect(text).toMatch(/status must be one of/);
    expect(text).toMatch(/priority must be one of/);
    expect(text).toMatch(/DT-003\): "title" is missing/);
    expect(text).toMatch(/DT-003\): "steps" must be a list/);
    // Completed is only believable with evidence (the standard's rule).
    expect(text).toMatch(/DT-004\): a Completed task needs "evidence"/);
    expect(validateDesk(null)).toHaveLength(1);
    expect(validateDesk({})).toHaveLength(1);
  });
});

describe('summary', () => {
  it('counts what waits on the owner and what blocks the agent', () => {
    const tasks = [
      task({ id: 'a', status: 'Not Started', blocking: true }),
      task({ id: 'b', status: 'In Progress' }),
      task({ id: 'c', status: 'Blocked', blocking: true }),
      task({ id: 'd', status: 'Completed', blocking: true, evidence: 'seen' }),
      task({ id: 'e', status: 'Not Applicable' }),
    ];
    expect(summary(tasks)).toEqual({ pending: 2, blocked: 1, completed: 1, blocking: 2, total: 5 });
    expect(tasks.filter(isOpen).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('rendering', () => {
  it('turns web addresses into links and nothing else into markup', () => {
    expect(linkify('See https://example.com/a?b=1&c=2.')).toBe(
      'See <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noreferrer noopener">https://example.com/a?b=1&amp;c=2</a>.',
    );
    expect(linkify('<img src=x onerror=alert(1)> "quoted"')).toBe(
      '&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot;',
    );
  });

  it('embeds the data so no task text can end the script or be read as a replacement pattern', () => {
    const html = renderDesk({
      tasks: [task({ title: '</script><b>boom</b> $& $1 $`', why: 'a </script> b' })],
    });
    // The data block cannot be closed from inside: every "<" in it is escaped.
    const data = /const TASKS = (\[.*?\]);\nconst TICKS_KEY/s.exec(html)![1]!;
    expect(data).not.toContain('<');
    expect(JSON.parse(data.replace(/\\u003c/g, '<'))[0].title).toBe(
      '</script><b>boom</b> $& $1 $`',
    );
    // Three script blocks (theme boot, theme toggle, the desk) and so three closers: none from the data.
    expect(html.match(/<\/script>/g)).toHaveLength(3);
  });

  it('is self-contained: no network, both themes, the product tokens', () => {
    const html = renderDesk({ tasks: [] });
    expect(html).not.toMatch(/https?:\/\/(?!\S*example)\S*\.(css|js)/);
    expect(html).not.toMatch(/<link\b/);
    expect(html).toContain('--bg: #f5f5f3');
    expect(html).toContain(":root[data-theme='dark']");
    expect(html).toContain('--bg: #121211');
    expect(html).toContain('pm.owner-desk.ticks');
    expect(renderIndex({ counts: summary([task()]) })).toContain('1 pending');
  });
});

describe('run', () => {
  const fresh = () => {
    const root = mkdtempSync(path.join(tmp, 'project-'));
    mkdirSync(path.join(root, 'References', 'owner-pages'), { recursive: true });
    // The generator requires a roadmap in the project root (PM-289).
    writeFileSync(path.join(root, 'ROADMAP.md'), '# Roadmap\n');
    return root;
  };
  const lines = () => {
    const out: string[] = [];
    return { out, log: (line: string) => void out.push(line) };
  };

  it('starts an empty desk, then builds the pages, leaving the data alone', () => {
    const root = fresh();
    const { out, log } = lines();
    expect(run(['--init'], root, log)).toBe(0);
    const data = path.join(root, 'References', 'owner-pages', 'owner-desk.json');
    expect(JSON.parse(readFileSync(data, 'utf8'))).toEqual({
      project: 'ProjectManager',
      tasks: [],
    });
    // Never overwrites what is there.
    writeFileSync(data, JSON.stringify({ tasks: [task()] }));
    expect(run(['--init'], root, log)).toBe(0);
    expect(JSON.parse(readFileSync(data, 'utf8')).tasks).toHaveLength(1);
    expect(run([], root, log)).toBe(0);
    expect(existsSync(path.join(root, 'References', 'owner-pages', 'owner-desk.html'))).toBe(true);
    expect(
      readFileSync(path.join(root, 'References', 'owner-pages', 'index.html'), 'utf8'),
    ).toContain('1 pending');
    expect(out.join('\n')).toMatch(/Wrote .*owner-desk\.html \(1 tasks\)/);
  });

  it('--check validates and writes nothing', () => {
    const root = fresh();
    const dir = path.join(root, 'References', 'owner-pages');
    writeFileSync(path.join(dir, 'owner-desk.json'), JSON.stringify({ tasks: [task()] }));
    const { out, log } = lines();
    expect(run(['--check'], root, log)).toBe(0);
    expect(out[0]).toMatch(/valid: 1 tasks, 1 pending/);
    expect(existsSync(path.join(dir, 'owner-desk.html'))).toBe(false);
  });

  it('refuses a missing, broken or invalid file with a reason, and writes no page', () => {
    const root = fresh();
    const dir = path.join(root, 'References', 'owner-pages');
    const { out, log } = lines();
    expect(run([], root, log)).toBe(1);
    expect(out.at(-1)).toMatch(/--init/);
    writeFileSync(path.join(dir, 'owner-desk.json'), '{ not json');
    expect(run([], root, log)).toBe(1);
    expect(out.at(-1)).toMatch(/not valid JSON/);
    writeFileSync(
      path.join(dir, 'owner-desk.json'),
      JSON.stringify({ tasks: [task({ status: 'Nope' })] }),
    );
    expect(run([], root, log)).toBe(1);
    expect(out.at(-1)).toMatch(/status must be one of/);
    expect(existsSync(path.join(dir, 'owner-desk.html'))).toBe(false);
  });

  it('refuses to build without ROADMAP.md in the project root', () => {
    const root = fresh();
    rmSync(path.join(root, 'ROADMAP.md'));
    const dir = path.join(root, 'References', 'owner-pages');
    writeFileSync(path.join(dir, 'owner-desk.json'), JSON.stringify({ tasks: [task()] }));
    const { out, log } = lines();
    expect(run([], root, log)).toBe(1);
    expect(out.join('\n')).toMatch(/ROADMAP\.md is missing/);
    expect(existsSync(path.join(dir, 'owner-desk.html'))).toBe(false);
  });
});
