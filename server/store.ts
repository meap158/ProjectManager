// Data access for projects and cards. All SQL lives here; routes and the scanner call these
// functions and never touch the database directly.

import { existsSync } from 'node:fs';
import {
  BOARD_PRESETS,
  CARD_KEY_PREFIX,
  CARD_STATUSES,
  type BoardPreset,
  type Card,
  type CardWithProject,
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
  board_preset: string | null;
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
  issue_url: string | null;
}

const now = () => new Date().toISOString();

export function cardKey(id: number): string {
  return `${CARD_KEY_PREFIX}-${id}`;
}

// ---- Projects ---------------------------------------------------------------------------------

/** Moves a project's commit-reference cursor (the last commit time whose card refs were applied). */
export function setRefsCursor(db: Db, projectId: number, cursor: string | null): void {
  db.prepare('UPDATE projects SET refs_cursor = ? WHERE id = ?').run(cursor, projectId);
}

/** Ids and folders of every tracked project (for background watchers). */
export function listProjectFolders(db: Db): { id: number; path: string }[] {
  return db.prepare('SELECT id, path FROM projects').all() as { id: number; path: string }[];
}

/** The project scanned longest ago (never-scanned first), with when that was. */
export function stalestProject(
  db: Db,
): { id: number; path: string; last_scanned_at: string | null } | null {
  return (
    (db
      .prepare(
        'SELECT id, path, last_scanned_at FROM projects ORDER BY last_scanned_at IS NOT NULL, last_scanned_at LIMIT 1',
      )
      .get() as { id: number; path: string; last_scanned_at: string | null } | undefined) ?? null
  );
}

export function listProjects(db: Db, scanState: (id: number) => ScanState): ProjectSummary[] {
  const rows = db
    .prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE')
    .all() as unknown as ProjectRow[];
  const counts = cardCountsByProject(db);
  const running = runningSessionsByProject(db);
  return rows.map((row) =>
    toSummary(row, counts.get(row.id), scanState(row.id), running.get(row.id)),
  );
}

export function getProject(db: Db, id: number, scan: ScanState): ProjectSummary | null {
  const row = getProjectRow(db, id);
  if (!row) return null;
  return toSummary(
    row,
    cardCountsByProject(db, id).get(id),
    scan,
    runningSessionsByProject(db, id).get(id),
  );
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

function isBoardPreset(value: string | null): value is BoardPreset {
  return (BOARD_PRESETS as readonly string[]).includes(value ?? '');
}

/** Switches a project's board column preset. Cards keep their statuses. */
export function setBoardPreset(db: Db, id: number, preset: BoardPreset): boolean {
  return (
    db.prepare('UPDATE projects SET board_preset = ? WHERE id = ?').run(preset, id).changes > 0
  );
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

function runningSessionsByProject(db: Db, projectId?: number): Map<number, number> {
  const rows = (
    projectId === undefined
      ? db
          .prepare(
            `SELECT project_id, COUNT(*) AS n FROM agent_sessions WHERE status = 'running' GROUP BY project_id`,
          )
          .all()
      : db
          .prepare(
            `SELECT project_id, COUNT(*) AS n FROM agent_sessions WHERE status = 'running' AND project_id = ?`,
          )
          .all(projectId)
  ) as { project_id: number | null; n: number }[];
  return new Map(rows.filter((r) => r.project_id !== null).map((r) => [r.project_id!, r.n]));
}

function emptyCounts(): CardCounts {
  return Object.fromEntries(CARD_STATUSES.map((s) => [s, 0])) as CardCounts;
}

function toSummary(
  row: ProjectRow,
  counts: CardCounts | undefined,
  scan: ScanState,
  runningSessions = 0,
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
    boardPreset: isBoardPreset(row.board_preset) ? row.board_preset : 'full',
    runningSessions,
    missing: !existsSync(row.path),
    scan,
  };
}

function parseJson<T>(value: string | null): T | null {
  return value ? (JSON.parse(value) as T) : null;
}

// ---- Settings (small persisted UI state) ------------------------------------------------------

export function getSetting<T>(db: Db, key: string): T | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setSetting(db: Db, key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
}

export function deleteSetting(db: Db, key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

// ---- Cards ------------------------------------------------------------------------------------

export function listCards(db: Db, projectId: number): Card[] {
  const rows = db
    .prepare('SELECT * FROM cards WHERE project_id = ? ORDER BY status, position, id')
    .all(projectId) as unknown as CardRow[];
  return rows.map(toCard);
}

/** Cards being worked on (In progress / Review) across every project, oldest change first. */
/** Every card in every project with its project name, most recently updated first (the global board; positions are per project). */
export function listAllCards(db: Db): CardWithProject[] {
  const rows = db
    .prepare(
      `SELECT c.*, p.name AS project_name FROM cards c JOIN projects p ON p.id = c.project_id
        ORDER BY c.updated_at DESC, c.id DESC`,
    )
    .all() as unknown as (CardRow & { project_name: string })[];
  return rows.map((r) => ({ ...toCard(r), projectName: r.project_name }));
}

export function listCardsInFlight(db: Db, projectIds: readonly number[] = []): CardWithProject[] {
  const scope = projectIds.length
    ? ` AND c.project_id IN (${projectIds.map(() => '?').join(',')})`
    : '';
  const rows = db
    .prepare(
      `SELECT c.*, p.name AS project_name FROM cards c JOIN projects p ON p.id = c.project_id
        WHERE c.status IN ('in_progress', 'review')${scope} ORDER BY c.updated_at`,
    )
    .all(...projectIds) as unknown as (CardRow & { project_name: string })[];
  return rows.map((r) => ({ ...toCard(r), projectName: r.project_name }));
}

export function getCard(db: Db, id: number): Card | null {
  const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
  return row ? toCard(row) : null;
}

export function insertCard(
  db: Db,
  projectId: number,
  input: { title: string; description: string; status: CardStatus; issueUrl?: string | null },
): Card {
  const position = topPosition(db, projectId, input.status); // New cards go on top.
  const ts = now();
  const id = nextCardId(db);
  db.prepare(
    `INSERT INTO cards (id, project_id, title, description, status, position, created_at, updated_at, closed_at, issue_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    input.title,
    input.description,
    input.status,
    position,
    ts,
    ts,
    input.status === 'done' ? ts : null,
    input.issueUrl ?? null,
  );
  return getCard(db, id)!;
}

/**
 * Card keys (PM-<id>) appear in commit messages, so an id must never be handed out twice. The
 * cards table has no AUTOINCREMENT (SQLite would reuse the highest id after a delete), so a
 * high-water mark in settings keeps ids strictly increasing, also for existing databases.
 */
function nextCardId(db: Db): number {
  const { max } = db.prepare('SELECT MAX(id) AS max FROM cards').get() as { max: number | null };
  const next = Math.max(max ?? 0, getSetting<number>(db, 'card_id_high_water') ?? 0) + 1;
  setSetting(db, 'card_id_high_water', next);
  return next;
}

export function updateCard(
  db: Db,
  id: number,
  patch: Partial<
    Pick<Card, 'title' | 'description' | 'status' | 'position' | 'linkedCommit' | 'issueUrl'>
  >,
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
       closed_at = ?, updated_at = ?, issue_url = ? WHERE id = ?`,
  ).run(
    next.title,
    next.description,
    next.status,
    next.position,
    next.linkedCommit,
    closedAt,
    now(),
    next.issueUrl ?? null,
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
    issueUrl: row.issue_url ?? null,
  };
}
