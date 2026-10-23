import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { RunJournal } from './runJournal.js';
import { RunLauncher } from './runLauncher.js';

it('launches a real pipe worker once and replays its completion after host restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-run-launcher-'));
  const file = path.join(dir, 'journal.db');
  const marker = path.join(dir, 'launches.txt');
  let journal = new RunJournal(file, 'host-one');
  try {
    const launcher = new RunLauncher(journal, path.join(dir, 'logs'));
    const input = {
      nonce: 'attempt',
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      argv: [
        process.execPath,
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(marker)},'one'); process.stdout.write('output'); process.stderr.write('error');`,
      ],
    };
    let output = '';
    launcher.launch(input, (text) => {
      output += text;
    });
    launcher.launch(input, () => {
      throw new Error('Duplicate must not launch');
    });
    // A real Node child can need more than Vitest's 1s polling default under CPU governance.
    await expect.poll(() => journal.get('attempt')?.state, { timeout: 10_000 }).toBe('exited');
    expect(journal.get('attempt')).toMatchObject({ exitCode: 0, signal: null });
    expect(output).toContain('output');
    expect(output).toContain('error');
    expect(readFileSync(marker, 'utf8')).toBe('one');
    expect(launcher.read('attempt', 0)?.data).toContain('output');
    expect(() =>
      launcher.launch({ ...input, argv: [process.execPath, '-e', 'process.exit(1)'] }, () => {}),
    ).toThrow(/conflicting/);
    journal.close();
    journal = new RunJournal(file, 'host-two');
    expect(new RunLauncher(journal, path.join(dir, 'logs')).launch(input, () => {})).toMatchObject({
      state: 'exited',
      exitCode: 0,
    });
    expect(readFileSync(marker, 'utf8')).toBe('one');
    const recovered = new RunLauncher(journal, path.join(dir, 'logs')).read('attempt', 0);
    expect(recovered?.data).toContain('output');
    expect(recovered?.data).toContain('error');
    expect(recovered?.nextOffset).toBe(recovered?.totalBytes);
  } finally {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

it('retains spawn failure without reauthorizing the same nonce', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-run-launcher-'));
  const journal = new RunJournal(path.join(dir, 'journal.db'), 'host');
  try {
    const launcher = new RunLauncher(journal, path.join(dir, 'logs'));
    const input = {
      nonce: 'missing',
      cwd: dir,
      env: {},
      argv: [path.join(dir, 'missing-executable')],
    };
    launcher.launch(input, () => {});
    await expect.poll(() => journal.get('missing')?.state).toBe('exited');
    expect(launcher.launch(input, () => {})).toMatchObject({
      state: 'exited',
      signal: 'spawn-error',
    });
  } finally {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('stops only live owned workers and acknowledges close before terminal replay', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-run-stop-'));
  const journal = new RunJournal(path.join(dir, 'journal.db'), 'host');
  const launcher = new RunLauncher(journal, path.join(dir, 'logs'));
  try {
    const input = {
      nonce: 'long',
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      argv: [process.execPath, '-e', 'setTimeout(()=>{},15000)'],
    };
    launcher.launch(input, () => {});
    expect(await launcher.stop('missing')).toBe(false);
    expect(await launcher.stop('long')).toBe(true);
    expect(journal.get('long')?.state).toBe('exited');
    expect(launcher.launch(input, () => {}).state).toBe('exited');
    launcher.launch({ ...input, nonce: 'timeout', timeoutMs: 100 }, () => {});
    await expect.poll(() => journal.get('timeout')?.state, { timeout: 6000 }).toBe('exited');
    expect(() => launcher.launch({ ...input, nonce: 'invalid', timeoutMs: 0 }, () => {})).toThrow(
      /timeout/,
    );
    expect(journal.get('invalid')).toBeNull();
  } finally {
    await launcher.stop('long');
    await launcher.stop('timeout');
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
