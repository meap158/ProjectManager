import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { MIGRATIONS, openDb } from './db.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-db-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

/**
 * Fingerprints of shipped migrations, in order. Real databases have run exactly these texts, so a
 * shipped migration must never be edited, removed or reordered: add new ones at the END of
 * MIGRATIONS (and append their fingerprint here once they ship).
 */
const SHIPPED = ['d29ae85f67a60cef', 'e78122dca62c1166', '4facd64294cfb28b', 'eb0951eac7774134'];

describe('MIGRATIONS', () => {
  it('is append-only: shipped migrations keep their text and position', () => {
    const fingerprints = MIGRATIONS.map((m) =>
      createHash('sha256').update(m).digest('hex').slice(0, 16),
    );
    expect(fingerprints.slice(0, SHIPPED.length)).toEqual(SHIPPED);
  });
});

describe('openDb', () => {
  it('migrates a fresh database to the full schema', () => {
    const db = openDb(':memory:');
    expect(columns(db, 'agent_sessions')).toEqual(
      expect.arrayContaining(['resume_json', 'terminal', 'card_id']),
    );
    expect(columns(db, 'settings')).toEqual(['key', 'value']);
  });

  it('repairs databases created by an earlier version of a shipped migration', () => {
    // Reproduce a real database: fully migrated (user_version 4) but agent_sessions was created
    // before resume_json was added to migration 2.
    const fresh = openDb(dir);
    fresh.exec('ALTER TABLE agent_sessions DROP COLUMN resume_json');
    expect(columns(fresh, 'agent_sessions')).not.toContain('resume_json');
    fresh.close();

    const repaired = openDb(dir);
    expect(columns(repaired, 'agent_sessions')).toContain('resume_json');
    // Idempotent: opening again changes nothing and doesn't throw.
    repaired.close();
    const again = openDb(dir);
    expect(columns(again, 'agent_sessions').filter((c) => c === 'resume_json')).toHaveLength(1);
    again.close();
  });
});

it('rebuilds cards so a card can belong to no project, without losing rows or references (PM-138)', () => {
  const legacyDir = mkdtempSync(path.join(dir, 'legacy-cards-'));
  const db = openDb(legacyDir);
  // Reproduce the shipped schema: cards.project_id was NOT NULL, with child rows referencing cards.
  db.exec(`DROP TABLE cards;
    CREATE TABLE cards (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('backlog','todo','in_progress','review','done')),
      position REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      closed_at TEXT, linked_commit TEXT, issue_url TEXT
    );
    CREATE INDEX cards_by_column ON cards (project_id, status, position);
    INSERT INTO projects(id,name,path,created_at) VALUES(1,'One','/one','now');
    INSERT INTO cards(id,project_id,title,description,status,position,created_at,updated_at)
      VALUES(1,1,'Assigned','','todo',1000,'now','now');
    INSERT INTO agent_runs(id,project_id,card_id,name,command_json,status,created_at,log_path)
      VALUES(1,1,1,'Run','{}','succeeded','now','/run.log');`);
  db.close();

  const repaired = openDb(legacyDir);
  try {
    // project_id is now optional, the existing card kept its project, and its run still points at it.
    const projectId = (
      repaired.prepare('PRAGMA table_info(cards)').all() as { name: string; notnull: number }[]
    ).find((c) => c.name === 'project_id');
    expect(projectId?.notnull).toBe(0);
    expect(repaired.prepare('SELECT project_id FROM cards WHERE id=1').get()).toMatchObject({
      project_id: 1,
    });
    expect(repaired.prepare('SELECT card_id FROM agent_runs WHERE id=1').get()).toMatchObject({
      card_id: 1,
    });
    // A card with no project stores NULL and survives a reopen.
    repaired
      .prepare(
        `INSERT INTO cards(id,project_id,title,description,status,position,created_at,updated_at)
         VALUES(2,NULL,'AllProjects','','todo',1000,'now','now')`,
      )
      .run();
    expect(repaired.prepare('SELECT project_id FROM cards WHERE id=2').get()).toMatchObject({
      project_id: null,
    });
  } finally {
    repaired.close();
  }
  const again = openDb(legacyDir);
  try {
    expect(again.prepare('SELECT project_id FROM cards WHERE id=2').get()).toMatchObject({
      project_id: null,
    });
  } finally {
    again.close();
  }
});

it('repairs the early execution schema without losing identities or restricting retries', () => {
  const legacyDir = mkdtempSync(path.join(dir, 'legacy-execution-'));
  const db = openDb(legacyDir);
  db.exec(`DROP TABLE agent_run_executions;
    CREATE TABLE agent_run_executions (
      nonce TEXT PRIMARY KEY, run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
      run_log_path TEXT NOT NULL, fingerprint TEXT NOT NULL, host_instance TEXT NOT NULL,
      host_generation INTEGER NOT NULL CHECK(host_generation > 0), dispatch_key TEXT,
      orchestrator_id TEXT, created_at INTEGER NOT NULL, UNIQUE(run_id,run_log_path)
    );
    INSERT INTO projects(id,name,path,created_at) VALUES(1,'One','/one','now');
    INSERT INTO agent_runs(id,project_id,name,command_json,status,created_at,log_path)
      VALUES(1,1,'Run','{}','running','now','/run.log');
    INSERT INTO agent_run_executions VALUES('original',1,'/run.log','fp','host',1,'dispatch','owner',1000);`);
  db.close();
  for (let i = 0; i < 2; i++) {
    const repaired = openDb(legacyDir);
    try {
      expect(
        repaired.prepare('SELECT * FROM agent_run_executions WHERE nonce=?').get('original'),
      ).toMatchObject({
        nonce: 'original',
        run_id: 1,
        run_log_path: '/run.log',
        attempt: 1,
        fingerprint: 'fp',
        host_instance: 'host',
        host_generation: 1,
        dispatch_key: 'dispatch',
        orchestrator_id: 'owner',
        created_at: 1000,
      });
      if (i === 0)
        repaired.exec(`INSERT INTO agent_run_executions
        VALUES('retry',1,'/run.log',2,'fp','host',1,'dispatch','owner',2000)`);
      expect(
        repaired.prepare('SELECT MAX(e.attempt) AS attempt FROM agent_run_executions e').get(),
      ).toMatchObject({ attempt: 2 });
    } finally {
      repaired.close();
    }
  }
});
