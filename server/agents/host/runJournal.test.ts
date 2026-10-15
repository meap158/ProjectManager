import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { RunJournal } from './runJournal.js';
import { DatabaseSync } from 'node:sqlite';

it('retains claims after abrupt process exit and never reauthorizes uncertain or completed launches', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-run-journal-'));
  const file = path.join(dir, 'journal.db');
  const source = `import { RunJournal } from ${JSON.stringify(new URL('./runJournal.ts', import.meta.url).href)};
    const journal=new RunJournal(process.argv[1],'old-host');
    journal.claim('claimed','args');
    journal.claim('running','args'); journal.started('running',1234);
    journal.claim('finished','args'); journal.started('finished',5678); journal.finished('finished',0,null);
    process.exit(86);`;
  try {
    const child = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', source, file],
      { encoding: 'utf8', timeout: 15000, windowsHide: true },
    );
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(86);
    const journal = new RunJournal(file, 'new-host');
    try {
      for (const nonce of ['claimed', 'running']) {
        expect(journal.claim(nonce, 'args')).toMatchObject({
          launch: false,
          run: { state: 'unknown' },
        });
        expect(journal.started(nonce, 9999)).toBe(false);
        expect(journal.finished(nonce, 0, null)).toBe(false);
      }
      expect(journal.claim('finished', 'args')).toMatchObject({
        launch: false,
        run: { state: 'exited', exitCode: 0 },
      });
      expect(() => journal.claim('finished', 'changed')).toThrow(/conflicting arguments/);
      expect(journal.claim('next', 'args').launch).toBe(true);
      expect(journal.claim('next', 'args').launch).toBe(false);
      expect(journal.started('next', 1111)).toBe(true);
      expect(journal.started('next', 2222)).toBe(false);
      expect(journal.unknown('next')).toBe(true);
      expect(journal.finished('next', 0, null)).toBe(false);
      expect(journal.get('missing')).toBeNull();
    } finally {
      journal.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('fences competing host completion while permitting the live owner to report its actual exit', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-run-journal-'));
  const first = new RunJournal(path.join(dir, 'journal.db'), 'one');
  const other = new RunJournal(path.join(dir, 'journal.db'), 'two');
  try {
    expect(first.claim('nonce', 'args').launch).toBe(true);
    expect(other.claim('nonce', 'args').launch).toBe(false);
    first.started('nonce', 1234);
    expect(other.get('nonce')?.state).toBe('unknown');
    expect(other.finished('nonce', 0, null)).toBe(false);
    expect(first.finished('nonce', 1, 'signal')).toBe(true);
    expect(first.finished('nonce', 0, null)).toBe(false);
    expect(other.get('nonce')).toMatchObject({ state: 'exited', exitCode: 1, signal: 'signal' });
  } finally {
    first.close();
    other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('upgrades the initial unversioned journal without losing claims and refuses future schemas', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-journal-upgrade-'));
  const file = path.join(dir, 'journal.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE executions(nonce TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,host_instance TEXT NOT NULL,
      state TEXT NOT NULL,pid INTEGER,exit_code INTEGER,signal TEXT);
      INSERT INTO executions VALUES('old','args','original','exited',1234,0,NULL);`);
    old.close();
    const journal = new RunJournal(file, 'new');
    expect(journal.claim('old', 'args')).toMatchObject({
      launch: false,
      run: { state: 'exited', exitCode: 0 },
    });
    journal.close();
    const future = new DatabaseSync(file);
    expect(future.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 });
    future.exec('PRAGMA user_version=2');
    future.close();
    expect(() => new RunJournal(file, 'old-code')).toThrow(/Unsupported run journal schema: 2/);
    const inspect = new DatabaseSync(file);
    try {
      expect(inspect.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 });
      expect(inspect.prepare('SELECT COUNT(*) AS n FROM executions').get()).toMatchObject({ n: 1 });
    } finally {
      inspect.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
