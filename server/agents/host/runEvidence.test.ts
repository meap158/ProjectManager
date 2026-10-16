import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, openDb } from '../../db.js';
import { startRunHost } from './runDaemon.js';
import { RunClient } from './runClient.js';
import { launchManagedRun } from './managedRun.js';
import { recoverManagedRuns } from './recoverRuns.js';
import { observeRunChanges } from '../runEvidence.js';

it('recovers completion evidence from the persisted pre-launch baseline without recapturing it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-run-evidence-'));
  const cwd = path.join(dir, 'repo');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cwd);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args],
      { cwd, stdio: 'pipe' },
    );
  git('init', '-q');
  writeFileSync(path.join(cwd, 'existing.txt'), 'initial');
  git('add', '.');
  git('commit', '-qm', 'Initial');
  writeFileSync(path.join(cwd, 'existing.txt'), 'already dirty');
  let db = openDb(path.join(dir, 'db'));
  const host = await startRunHost(dir);
  const client = await RunClient.connect(host.connection.address, host.connection.token);
  let nonce: string | undefined;
  try {
    db.prepare("INSERT INTO projects(id,name,path,created_at) VALUES(1,'Fixture',?,'now')").run(
      cwd,
    );
    db.prepare(
      `INSERT INTO agent_runs(id,project_id,name,command_json,status,created_at,log_path)
      VALUES(1,1,'Evidence','{"command":["fixture"]}','running','now',?)`,
    ).run(path.join(dir, 'output.log'));
    const input = {
      cwd,
      env: { ...process.env } as Record<string, string>,
      argv: [
        process.execPath,
        '-e',
        "require('node:fs').writeFileSync('worker.txt','worker output')",
      ],
    };
    const launched = await launchManagedRun(db, client, 1, 1, input);
    nonce = launched.identity.nonce;
    await expect.poll(async () => (await client.status(nonce!))?.state).toBe('exited');
    const saved = db
      .prepare('SELECT baseline_json FROM agent_run_evidence WHERE nonce=?')
      .get(nonce);
    db.close();
    db = openDb(path.join(dir, 'db'));
    await launchManagedRun(db, client, 1, 1, input);
    expect(
      db.prepare('SELECT baseline_json FROM agent_run_evidence WHERE nonce=?').get(nonce),
    ).toEqual(saved);
    await recoverManagedRuns(
      db,
      dir,
      () => true,
      () => {},
    );
    const row = db.prepare('SELECT status,changes_json FROM agent_runs WHERE id=1').get() as {
      status: string;
      changes_json: string;
    };
    expect(row.status).toBe('succeeded');
    const changes = JSON.parse(row.changes_json);
    expect(changes).toMatchObject({
      files: ['worker.txt'],
      commits: 0,
      observation: { baselineAt: expect.any(String), observedAt: expect.any(String) },
    });
    expect(Date.parse(changes.observation.observedAt)).toBeGreaterThanOrEqual(
      Date.parse(changes.observation.baselineAt),
    );
    writeFileSync(path.join(cwd, 'later.txt'), 'after completion');
    await recoverManagedRuns(
      db,
      dir,
      () => true,
      () => {},
    );
    expect(db.prepare('SELECT changes_json FROM agent_runs WHERE id=1').get()).toMatchObject({
      changes_json: row.changes_json,
    });
    db.prepare('DELETE FROM agent_run_evidence WHERE nonce=?').run(nonce);
    expect(await observeRunChanges(db, launched.identity)).toBeNull();
  } finally {
    if (nonce) await client.stop(nonce).catch(() => false);
    client.close();
    await host.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

it('upgrades an existing database without inventing historical baselines', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-evidence-upgrade-'));
  try {
    const old = new DatabaseSync(path.join(dir, 'projectmanager.db'));
    const prior = MIGRATIONS.findIndex((sql) => sql.startsWith('CREATE TABLE agent_run_evidence'));
    old.exec(MIGRATIONS.slice(0, prior).join('\n'));
    old.exec(`PRAGMA user_version=${prior};
      INSERT INTO projects(id,name,path,created_at) VALUES(1,'Old','/old','now');
      INSERT INTO agent_runs(id,project_id,name,command_json,status,created_at,log_path)
      VALUES(1,1,'Old','{}','succeeded','now','/old.log');`);
    old.close();
    for (let i = 0; i < 2; i++) {
      const db = openDb(dir);
      try {
        expect(db.prepare('SELECT COUNT(*) AS n FROM agent_run_evidence').get()).toMatchObject({
          n: 0,
        });
        expect(
          db.prepare('SELECT status,changes_json FROM agent_runs WHERE id=1').get(),
        ).toMatchObject({ status: 'succeeded', changes_json: null });
      } finally {
        db.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
