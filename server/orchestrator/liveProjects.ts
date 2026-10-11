import type { Db } from '../db.js';

/** Attention follow-up only needs occupancy, never run prompts or recorded changes. */
export function liveRunProjects(db: Db): number[] {
  const rows = db
    .prepare("SELECT DISTINCT project_id FROM agent_runs WHERE status IN ('running', 'queued')")
    .all() as { project_id: number }[];
  return rows.map((row) => row.project_id);
}
