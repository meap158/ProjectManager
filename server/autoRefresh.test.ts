import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { getProjectRow, insertProject } from './store.js';

// Projects refresh on their own: the stalest one is rescanned once it is older than maxAgeMs.

const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-refresh-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');

describe('periodic refresh', () => {
  it('rescans the stalest project once it is old enough, one at a time', async () => {
    const db = openDb(':memory:');
    const app = createApp(db);
    const id = insertProject(db, 'stale', dir);
    expect(getProjectRow(db, id)!.last_scanned_at).toBeNull();

    const stop = app.scanner.refreshPeriodically(60_000, 50);
    try {
      let scanned: string | null = null;
      for (let i = 0; i < 100 && !scanned; i++) {
        await new Promise((r) => setTimeout(r, 50));
        scanned = getProjectRow(db, id)!.last_scanned_at;
      }
      expect(scanned).not.toBeNull();
      // Fresh now (younger than maxAgeMs): no further scans.
      await new Promise((r) => setTimeout(r, 300));
      expect(getProjectRow(db, id)!.last_scanned_at).toBe(scanned);
    } finally {
      stop();
    }
  }, 20_000);
});
