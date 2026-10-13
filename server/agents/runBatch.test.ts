import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { openDb } from '../db.js';
import { AgentSupervisor } from './supervisor.js';

it('batch hydration matches individual runs with one SQL read and preserves requested order', async () => {
  const db = openDb(':memory:');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-run-batch-'));
  const supervisor = new AgentSupervisor(db, dir);
  try {
    await supervisor.ready;
    await supervisor.shutdown();
    db.exec(`INSERT INTO projects(id,name,path,created_at) VALUES (1,'One','/one','now');
      INSERT INTO cards(id,project_id,title,status,position,created_at,updated_at) VALUES (1,1,'Task','review',0,'now','now');
      INSERT INTO agent_runs(id,project_id,card_id,name,command_json,status,created_at,log_path) VALUES
      (1,1,1,'Linked','{"command":[]}','succeeded','now',''),
      (2,1,NULL,'Unlinked','{"command":[]}','failed','now','');`);
    const expected = [supervisor.getRun(2), supervisor.getRun(1)];
    const prepare = vi.spyOn(db, 'prepare');
    expect(supervisor.getRunsByIds([2, 1, 999, 2])).toEqual(expected);
    expect(prepare).toHaveBeenCalledTimes(1);
    prepare.mockClear();
    expect(supervisor.getRunsByIds([])).toEqual([]);
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
