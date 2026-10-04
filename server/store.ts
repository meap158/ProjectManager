// Data access for projects and cards. All SQL lives here; routes and the scanner call these
// functions and never touch the database directly.

import { existsSync } from 'node:fs';
import {
  CARD_KEY_PREFIX,
  CARD_STATUSES,
  type Card,
  type CardCounts,
  type CardStatus,
  type CodeStats,
  type DiskStats,
  type GitStats,
  type ProjectSummary,
  type ScanState,
} from '../shared/types.js';
import type { Db } from './db.js';

interface ProjectRow {
  id: number;
  name: string;
  path: string;
  created_at: string;
  last_scanned_at: string | null;
  code_json: string | null;
  disk_json: string | null;
  git_json: string | null;
  refs_cursor: string | null;
}

interface CardRow {
  id: number;
  project_id: number;
  title: string;
  description: string;
  status: CardStatus;
  position: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  linked_commit: string | null;
}

const now = () => new Date().toISOString();

export function cardKey(id: number): string {
  return `${CARD_KEY_PREFIX}-${id}`;
}

// ---- Projects ---------------------------------------------------------------------------------

export function listProjects(db: Db, scanState: (id: number) => ScanState): ProjectSummary[] {
  const rows = db
    .prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE')
    .all() as unknown as ProjectRow[];
  const counts = cardCountsByProject(db);
  return rows.map((row) => toSummary(row, counts.get(row.id), scanState(row.id)));
}

export function getProject(db: Db, id: number, scan: ScanState): ProjectSummary | null {
  const row = getProjectRow(db, id);
  if (!row) return null;
  return toSummary(row, cardCountsByProject(db, id).get(id), scan);
}

export function getProjectRow(db: Db, id: number): ProjectRow | null {
  return (
    (db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined) ?? null
  );
}

export function findProjectByPath(db: Db, projectPath: string): ProjectRow | null {
  // Windows paths are case-insensitive; compare case-insensitively everywhere for simplicity.
  return (
    (db.prepare('SELECT * FROM projects WHERE path = ? COLLATE NOCASE').get(projectPath) as
      ProjectRow | undefined) ?? null
  );
}

export function insertProject(db: Db, name: string, projectPath: string): number {
  const result = db
    .prepare('INSERT INTO projects (name, path, created_at) VALUES (?, ?, ?)')
    .run(name, projectPath, now());
  return Number(result.lastInsertRowid);
}

export function renameProject(db: Db, id: number, name: string): boolean {
  return db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id).changes > 0;
}

export function deleteProject(db: Db, id: number): boolean {
  return db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
}

export function saveScanResults(
  db: Db,
  id: number,
  results: { code: CodeStats; disk: DiskStats; git: GitStats; refsCursor: string | null },
): void {
  db.prepare(
    `UPDATE projects
       SET code_json = ?, disk_json = ?, git_json = ?, refs_cursor = ?, last_scanned_at = ?
     WHERE id = ?`,
  ).run(
    JSON.stringify(results.code),
    JSON.stringify(results.disk),
    JSON.stringify(results.git),
    results.refsCursor,
    now(),
    id,
  );
}

function cardCountsByProject(db: Db, projectId?: number): Map<number, CardCounts> {
  const rows = (
    projectId === undefined
      ? db
          .prepare(
            'SELECT project_id, status, COUNT(*) AS n FROM cards GROUP BY project_id, status',
          )
          .all()
      : db
          .prepare(
            'SELECT project_id, status, COUNT(*) AS n FROM cards WHERE project_id = ? GROUP BY status',
          )
          .all(projectId)
  ) as { project_id: number; status: CardStatus; n: number }[];
  const map = new Map<number, CardCounts>();
  for (const row of rows) {
    const counts = map.get(row.project_id) ?? emptyCounts();
    counts[row.status] = row.n;
    map.set(row.project_id, counts);
  }
  return map;
}

function emptyCounts(): CardCounts {
  return Object.fromEntries(CARD_STATUSES.map((s) => [s, 0])) as CardCounts;
}

function toSummary(
  row: ProjectRow,
  counts: CardCounts | undefined,
  scan: ScanState,
): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    lastScannedAt: row.last_scanned_at,
    code: parseJson<CodeStats>(row.code_json),
    disk: parseJson<DiskStats>(row.disk_json),
    git: parseJson<GitStats>(row.git_json),
    cardCounts: counts ?? emptyCounts(),
    missing: !existsSync(row.path),
    scan,
  };
}

function parseJson<T>(value: string | null): T | null {
  return value ? (JSON.parse(value) as T) : null;
}

// ---- Cards ------------------------------------------------------------------------------------

export function listCards(db: Db, projectId: number): Card[] {
  const rows = db
    .prepare('SELECT * FROM cards WHERE project_id = ? ORDER BY status, position, id')
    .all(projectId) as unknown as CardRow[];
  return rows.map(toCard);
}

export function getCard(db: Db, id: number): Card | null {
  const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
  return row ? toCard(row) : null;
}

export function insertCard(
  db: Db,
  projectId: number,
  input: { title: string; description: string; status: CardStatus },
): Card {
  const position = topPosition(db, projectId, input.status); // New cards go on top.
  const ts = now();
  const result = db
    .prepare(
      `INSERT INTO cards (project_id, title, description, status, position, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      input.title,
      input.description,
      input.status,
      position,
      ts,
      ts,
      input.status === 'done' ? ts : null,
    );
  return getCard(db, Number(result.lastInsertRowid))!;
}

export function updateCard(
  db: Db,
  id: number,
  patch: Partial<Pick<Card, 'title' | 'description' | 'status' | 'position' | 'linkedCommit'>>,
): Card | null {
  const existing = getCard(db, id);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  if (patch.status && patch.status !== existing.status && patch.position === undefined) {
    next.position = topPosition(db, existing.projectId, patch.status);
  }
  let closedAt = existing.closedAt;
  if (next.status === 'done' && existing.status !== 'done') closedAt = now();
  if (next.status !== 'done') closedAt = null;
  db.prepare(
    `UPDATE cards SET title = ?, description = ?, status = ?, position = ?, linked_commit = ?,
       closed_at = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.title,
    next.description,
    next.status,
    next.position,
    next.linkedCommit,
    closedAt,
    now(),
    id,
  );
  return getCard(db, id);
}

/** Moves a card to the top of another column (used by automatic commit-reference moves). */
export function moveCardToTop(db: Db, id: number, status: CardStatus, commit: string): void {
  updateCard(db, id, { status, linkedCommit: commit });
}

function topPosition(db: Db, projectId: number, status: CardStatus): number {
  const { min } = db
    .prepare('SELECT MIN(position) AS min FROM cards WHERE project_id = ? AND status = ?')
    .get(projectId, status) as { min: number | null };
  return min === null ? 1000 : min - 1000;
}

export function deleteCard(db: Db, id: number): boolean {
  return db.prepare('DELETE FROM cards WHERE id = ?').run(id).changes > 0;
}

function toCard(row: CardRow): Card {
  return {
    id: row.id,
    projectId: row.project_id,
    key: cardKey(row.id),
    title: row.title,
    description: row.description,
    status: row.status,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    linkedCommit: row.linked_commit,
  };
}
