import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { slashCommands, suggestFiles } from './completions.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'pm-completions-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

describe('chat composer suggestions (PM-117)', () => {
  it("lists the CLI's built-in commands, then custom commands and skills", async () => {
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    write(
      path.join(project, '.claude', 'commands', 'deploy.md'),
      '---\ndescription: Ship it\n---\nDo it.',
    );
    write(path.join(project, '.claude', 'commands', 'frontend', 'test.md'), '# Run the UI tests\n');
    write(path.join(home, '.claude', 'commands', 'standup.md'), 'Write my standup notes');
    write(
      path.join(home, '.claude', 'skills', 'pdf', 'SKILL.md'),
      '---\nname: pdf\ndescription: Work with PDF files\n---\n',
    );
    const commands = await slashCommands('claude', project, home);
    expect(commands[0]).toMatchObject({ name: 'clear', source: 'builtin' });
    expect(commands.filter((c) => c.source !== 'builtin')).toEqual([
      { name: 'deploy', description: 'Ship it', source: 'project' },
      { name: 'frontend:test', description: 'Run the UI tests', source: 'project' },
      { name: 'standup', description: 'Write my standup notes', source: 'user' },
      { name: 'pdf', description: 'Work with PDF files', source: 'skill' },
    ]);
    const codexHome = path.join(root, 'codex-home');
    write(path.join(codexHome, '.codex', 'prompts', 'triage.md'), 'Triage the issue');
    const codex = await slashCommands('codex', project, codexHome);
    expect(codex.find((c) => c.name === 'prompts:triage')).toMatchObject({ source: 'user' });
    expect(codex.some((c) => c.name === 'approvals')).toBe(true);
    expect(await slashCommands('grok', project, home)).toEqual([]);
  });

  it('matches files by name first, then by path', async () => {
    const project = path.join(root, 'files');
    mkdirSync(project, { recursive: true });
    // Isolate Git discovery from an enclosing checkout when TEMP lives under ignored data/.
    execFileSync('git', ['init', '-q'], { cwd: project, windowsHide: true });
    for (const f of [
      'src/app.ts',
      'src/components/AppShell.tsx',
      'docs/apple-notes.md',
      'mapper/x.ts',
    ])
      write(path.join(project, f), '');
    expect(await suggestFiles(project, 'app')).toEqual([
      'src/app.ts',
      'docs/apple-notes.md',
      'src/components/AppShell.tsx',
      'mapper/x.ts',
    ]);
    expect(await suggestFiles(project, 'nothing-like-this')).toEqual([]);
  });
});
