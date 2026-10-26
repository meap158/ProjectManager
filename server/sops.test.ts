import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SOPS, checkProject, sopCardText, sopInfo } from './sops.js';

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
        'AGENTS.md': '# Rules\n- **Writing style:** see blader/humanizer.\n',
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
    const r = await checkProject(root);
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
    const r = await checkProject(root);
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
    expect((await checkProject(root)).launcher).toEqual({
      state: 'fail',
      detail: 'launch.bat sets no window title',
    });
    const gone = await checkProject(path.join(os.tmpdir(), 'pm-sops-no-such-folder'));
    expect(new Set(Object.values(gone).map((v) => v.detail))).toEqual(
      new Set(['Folder not found']),
    );
  });

  it('writes a card an agent can act on without the checks', () => {
    const sop = sopInfo().find((s) => s.id === 'roadmap')!;
    const card = sopCardText(sop, 'No ROADMAP.md');
    expect(card.title).toBe('SOP: Roadmap');
    expect(card.description).toContain('Found: No ROADMAP.md');
    expect(card.description).toContain(`How to fix: ${sop.fix}`);
    expect(sopInfo().every((s) => !('check' in s))).toBe(true);
  });
});
