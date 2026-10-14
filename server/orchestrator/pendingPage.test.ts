import { expect, it } from 'vitest';
import { openDb } from '../db.js';
import { listCardsInFlight } from '../store.js';
import { buildSituation, STALLED_MS } from './situation.js';
import { listSituationRuns } from './situationRuns.js';
import { pendingDatabasePage } from './pendingPage.js';

it('matches mixed-source situation order across every boundary without loading card descriptions', () => {
  const db = openDb(':memory:');
  try {
    const now = Date.parse('2026-10-15T00:00:00Z');
    db.exec(`INSERT INTO projects(id,name,path,created_at) VALUES (1,'One','/one','now'),(2,'Two','/two','now');
      INSERT INTO cards(id,project_id,title,status,position,created_at,updated_at) VALUES
      (1,1,'Stalled','in_progress',0,'now','2020-01-01'),
      (2,1,'Session worker','in_progress',0,'now','2020-01-01'),
      (3,1,'Run worker','in_progress',0,'now','2020-01-01'),
      (4,2,'Outside','in_progress',0,'now','2020-01-01');
      INSERT INTO agent_runs(id,project_id,card_id,name,command_json,status,created_at,log_path,changes_json) VALUES
      (1,1,1,'Review','[]','succeeded','now','', '{"files":["one.ts"],"commits":2}'),
      (2,1,3,'Live','[]','running','now','',NULL),
      (3,2,4,'Outside','[]','failed','now','',NULL);`);
    // A card exactly on the threshold is not stalled.
    db.prepare(
      "INSERT INTO cards(id,project_id,title,status,position,created_at,updated_at) VALUES (5,1,'Boundary','in_progress',0,'now',?)",
    ).run(new Date(now - STALLED_MS).toISOString());
    const cards = listCardsInFlight(db, [1]);
    const runs = listSituationRuns(db, [1], false);
    const input = { projects: [], cards, runs, sessions: [], projectIds: [1], now };
    const full = buildSituation(input, false).needsAttention.filter((item) => item.cardId !== 2);
    const prefix = [
      {
        kind: 'project-alert' as const,
        projectId: 1,
        projectName: 'One',
        title: 'Alert',
        detail: 'Pending',
      },
    ];
    const expected = [...prefix, ...full];
    for (let offset = 0; offset <= expected.length + 1; offset++) {
      const page = pendingDatabasePage(db, [1], [2], new Map(), prefix, offset, 2, now);
      expect(page.total).toBe(expected.length);
      expect(page.items).toEqual(expected.slice(offset, offset + 2));
    }
  } finally {
    db.close();
  }
});
