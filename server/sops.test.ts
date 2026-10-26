import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SopStore, checkProject, parseSops, sopCardText, sopInfo } from './sops.js';

const SOPS = new SopStore(null).current().sops;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function project(files: Record<string, string>, git = false): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pm-sops-'));
  dirs.push(root);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), body);
  }
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
  }
  return root;
}

describe('SOP checks (PM-316)', () => {
  it('passes a project that follows the standard', async () => {
    const root = project(
      {
        'AGENTS.md':
          '# Rules\n- **Writing style:** see blader/humanizer.\n- **Process cleanup:** only our own PIDs.\n',
        'CLAUDE.md': '@AGENTS.md\n',
        'AGENT_HANDOVER.md': 'state',
        '.gitignore': 'AGENT_HANDOVER.md\n.env\n',
        'ROADMAP.md': '# Roadmap',
        'References/owner-pages/owner-desk.json': '{}',
        'package.json': '{"dependencies":{"react":"18"}}',
        'start.cmd': '@echo off\ntitle Demo - Server\nnpm run dev\n',
        'DESIGN.md': '# Design',
      },
      true,
    );
    const r = await checkProject(SOPS, root);
    expect(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.state]))).toEqual(
      Object.fromEntries(SOPS.map((s) => [s.id, 'pass'])),
    );
  });

  it('names each gap, and leaves SOPs that do not apply out', async () => {
    const root = project(
      {
        'CLAUDE.md': '# Rules only here',
        '.env': 'KEY=1',
        '.env.example': 'KEY=',
        'AGENT_HANDOVER.md': 'state',
      },
      true,
    );
    const r = await checkProject(SOPS, root);
    expect(r['agent-instructions']).toEqual({
      state: 'fail',
      detail: 'Rules live in CLAUDE.md; there is no AGENTS.md',
    });
    expect(r['no-secrets']).toEqual({ state: 'fail', detail: 'Tracked: .env' });
    expect(r.handover).toEqual({ state: 'fail', detail: 'AGENT_HANDOVER.md is tracked by git' });
    expect(r['writing-style']!.state).toBe('fail');
    expect(r.launcher!.state).toBe('na');
    expect(r.design!.state).toBe('na');
  });

  it('asks a launcher to set a window title, and reports a missing folder once per SOP', async () => {
    const root = project({ 'package.json': '{}', 'launch.bat': '@echo off\nnpm start\n' });
    expect((await checkProject(SOPS, root)).launcher).toEqual({
      state: 'fail',
      detail: 'launch.bat: no window title',
    });
    const gone = await checkProject(SOPS, path.join(os.tmpdir(), 'pm-sops-no-such-folder'));
    expect(new Set(Object.values(gone).map((v) => v.detail))).toEqual(
      new Set(['Folder not found']),
    );
  });

  it('writes a card an agent can act on without the checks', () => {
    const sop = sopInfo(SOPS).find((s) => s.id === 'roadmap')!;
    const card = sopCardText(sop, 'No ROADMAP.md');
    expect(card.title).toBe('SOP: Roadmap');
    expect(card.description).toContain('Found: No ROADMAP.md');
    expect(card.description).toContain(`How to fix: ${sop.fix}`);
    expect(sopInfo(SOPS).every((s) => !('check' in s))).toBe(true);
  });

  it('reads the SOPs as YAML and names the line of a problem', () => {
    const lines = (...l: string[]) => l.join('\n') + '\n';
    const sop = (id: string, check: string) =>
      lines(
        `  - id: ${id}`,
        '    title: X',
        '    short: X',
        '    summary: s',
        '    why: w',
        '    how: h',
        '    fix: f',
        '    checks:',
        `      - ${check}`,
      );
    const file = (...sops: string[]) => lines('version: 1', 'sops:') + sops.join('');
    expect(parseSops(file(sop('x', 'file_exists: README.md')))[0]!.checks).toEqual([
      { file_exists: 'README.md' },
    ]);
    // An unknown check kind (there is no "run a command"), a path out of the project, a bad regex.
    expect(() => parseSops(file(sop('x', 'run: rm -rf /')))).toThrow(
      /^Line 11.*Not a check this file knows/,
    );
    expect(() => parseSops(file(sop('x', 'file_exists: ../secret')))).toThrow(/inside the project/);
    expect(() => parseSops(file(sop('x', 'root_files: "(["')))).toThrow(/Not a valid regex/);
    expect(() => parseSops(lines('version: 1', 'sops: ['))).toThrow(/^Line \d+, column \d+/);
    expect(() => parseSops(file(sop('x', 'file_exists: a'), sop('x', 'file_exists: b')))).toThrow(
      /Duplicate id "x"/,
    );
  });

  it("saves the owner's copy only when it validates, falls back on a broken one, and resets", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-sops-store-'));
    dirs.push(dir);
    const store = new SopStore(dir);
    expect(store.current()).toMatchObject({ custom: false, error: null });
    const edited = store.defaultSource().replace('title: Roadmap', 'title: Product roadmap');
    store.save(edited);
    expect(store.current().sops.find((s) => s.id === 'roadmap')!.title).toBe('Product roadmap');
    expect(store.source()).toEqual({ yaml: edited.replace(/\r\n/g, '\n'), custom: true });
    expect(() => store.save('version: 2\nsops: []\n')).toThrow();
    expect(store.source().yaml).toBe(edited.replace(/\r\n/g, '\n'));
    // Broken by hand outside the app: the defaults run, and the problem is reported.
    writeFileSync(path.join(dir, 'sops.yml'), 'version: 1\nsops: nope\n');
    expect(store.current()).toMatchObject({ custom: true, error: expect.stringMatching(/sops/) });
    expect(store.current().sops.length).toBe(SOPS.length);
    store.reset();
    expect(store.current()).toMatchObject({ custom: false, error: null });
  });

  it('skips a disabled SOP', async () => {
    const sops = parseSops(
      new SopStore(null)
        .defaultSource()
        .replace(
          '    pass: ROADMAP.md present',
          '    enabled: false\n    pass: ROADMAP.md present',
        ),
    );
    const root = project({ 'AGENTS.md': '' });
    expect(Object.keys(await checkProject(sops, root))).not.toContain('roadmap');
    expect(sopInfo(sops).map((s) => s.id)).not.toContain('roadmap');
  });
});
