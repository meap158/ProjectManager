import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

const installer = path.resolve('scripts/install-card-link-hook.mjs');
it('installs only on request, warns without blocking commits, and never overwrites hooks', () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'pm-hook space-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: folder, encoding: 'utf8' });
  try {
    git(['init', '-q']);
    git(['config', 'user.name', 'Hook test']);
    git(['config', 'user.email', 'hook@example.test']);
    // A module project must also run the extensionless Git hook correctly.
    writeFileSync(path.join(folder, 'package.json'), '{"type":"module"}');
    expect(() => readFileSync(path.join(folder, '.git', 'hooks', 'commit-msg'))).toThrow();
    execFileSync(process.execPath, [installer, '--project', folder]);
    const hook = path.join(folder, '.git', 'hooks', 'commit-msg');
    const before = readFileSync(hook, 'utf8');
    expect(() =>
      execFileSync(process.execPath, [installer, '--project', folder], { stdio: 'pipe' }),
    ).toThrow();
    expect(readFileSync(hook, 'utf8')).toBe(before);
    // Run the installed hook directly to inspect warnings, including missing/unreadable input.
    const message = path.join(folder, 'message');
    const invoke = (text: string) => {
      writeFileSync(message, text);
      return spawnSync(process.execPath, [hook, message], { encoding: 'utf8' });
    };
    const missing = invoke('No card here\n');
    expect(missing.status).toBe(0);
    expect(missing.stderr).toContain('Commit allowed');
    expect(invoke('Change\n\nRefs PM-594\n').stderr).not.toContain('ProjectManager:');
    expect(invoke('Change\n\nFixes: PM-594\n').stderr).not.toContain('ProjectManager:');
    expect(invoke('# Refs PM-594\nNo card\n').stderr).toContain('Commit allowed');
    expect(() =>
      execFileSync(process.execPath, [hook, 'missing'], { stdio: 'pipe' }),
    ).not.toThrow();
    // A real Git commit proves the executable template cannot veto the commit.
    git(['commit', '--allow-empty', '-m', 'Missing card reference']);
    git(['commit', '--allow-empty', '-m', 'Linked change', '-m', 'Fixes PM-594']);
    git(['config', 'core.hooksPath', 'custom hooks']);
    expect(() =>
      execFileSync(process.execPath, [installer, '--project', folder], { stdio: 'pipe' }),
    ).toThrow();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
