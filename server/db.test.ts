import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb } from './db.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-db-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

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
