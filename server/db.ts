import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

// Append-only list of migrations; the index + 1 is stored in PRAGMA user_version.
// Never edit a migration that has shipped — add a new one.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    path            TEXT NOT NULL UNIQUE,
    created_at      TEXT NOT NULL,
    last_scanned_at TEXT,
    code_json       TEXT,
    disk_json       TEXT,
    git_json        TEXT,
    -- Committer date of the newest commit already checked for card references.
    refs_cursor     TEXT
  );

  CREATE TABLE cards (
    id            INTEGER PRIMARY KEY,
    project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL
                  CHECK (status IN ('backlog', 'todo', 'in_progress', 'review', 'done')),
    position      REAL NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    closed_at     TEXT,
    linked_commit TEXT
  );

  CREATE INDEX cards_by_column ON cards (project_id, status, position);
  `,
  // Agent CLI sessions and runs. Sessions are supervised across restarts/reboots via
  // desired_state + supervise; stdin written while down waits in agent_input_queue.
  `
  CREATE TABLE agent_sessions (
    id                INTEGER PRIMARY KEY,
    project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    provider_id       TEXT NOT NULL DEFAULT 'custom',
    command_json      TEXT NOT NULL,
    -- argv for relaunching with conversational continuity (null: fresh start).
    resume_json       TEXT,
    cwd               TEXT NOT NULL,
    pid               INTEGER,
    status            TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'exited', 'killed', 'dead')),
    exit_code         INTEGER,
    desired_state     TEXT NOT NULL DEFAULT 'running'
                      CHECK (desired_state IN ('running', 'stopped')),
    supervise         INTEGER NOT NULL DEFAULT 1,
    restarts          INTEGER NOT NULL DEFAULT 0,
    last_restart_at   TEXT,
    created_at        TEXT NOT NULL,
    started_at        TEXT NOT NULL,
    ended_at          TEXT,
    log_path          TEXT NOT NULL
  );

  CREATE TABLE agent_input_queue (
    id          INTEGER PRIMARY KEY,
    session_id  INTEGER NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    data        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE agent_runs (
    id              INTEGER PRIMARY KEY,
    project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    card_id         INTEGER REFERENCES cards(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    provider_id     TEXT NOT NULL DEFAULT 'custom',
    command_json    TEXT NOT NULL,
    prompt          TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'killed')),
    exit_code       INTEGER,
    error           TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 3,
    validation      TEXT CHECK (validation IN ('accepted', 'rejected')),
    validated_at    TEXT,
    validated_move  TEXT CHECK (validated_move IN ('backlog', 'todo', 'in_progress', 'review', 'done')),
    created_at      TEXT NOT NULL,
    started_at      TEXT,
    ended_at        TEXT,
    log_path        TEXT NOT NULL
  );

  CREATE INDEX agent_sessions_by_project ON agent_sessions (project_id, id);
  CREATE INDEX agent_runs_by_project ON agent_runs (project_id, id);
  CREATE INDEX agent_runs_by_card ON agent_runs (card_id, id);
  `,
  // Run autonomy level + recorded git changes; session terminal mode (pty vs pipe).
  `
  ALTER TABLE agent_runs ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'edit'
    CHECK (autonomy IN ('read', 'edit', 'full'));
  ALTER TABLE agent_runs ADD COLUMN changes_json TEXT;
  ALTER TABLE agent_sessions ADD COLUMN terminal TEXT NOT NULL DEFAULT 'pipe'
    CHECK (terminal IN ('pty', 'pipe'));
  `,
  // Agent workspace: small key/value store for UI state that must survive restarts (pane
  // layout), and an optional link from a session to the Kanban card it works on.
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  ALTER TABLE agent_sessions ADD COLUMN card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL;
  `,
  // Agent CLI installs (Settings): one-shot installer runs with streamed logs.
  `
  CREATE TABLE agent_installs (
    id            INTEGER PRIMARY KEY,
    provider_id   TEXT NOT NULL,
    name          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'succeeded', 'failed', 'killed')),
    exit_code     INTEGER,
    error         TEXT,
    created_at    TEXT NOT NULL,
    started_at    TEXT,
    ended_at      TEXT,
    log_path      TEXT NOT NULL
  );

  CREATE INDEX agent_installs_by_provider ON agent_installs (provider_id, id);
  `,
  // Per-project board column preset (Settings → Boards).
  `
  ALTER TABLE projects ADD COLUMN board_preset TEXT NOT NULL DEFAULT 'full'
    CHECK (board_preset IN ('full', 'simple', 'capture'));
  `,
  // Auditable, card-scoped agent board mutations.
  `CREATE TABLE board_agent_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('session', 'run')),
    owner_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX board_agent_audit_by_card ON board_agent_audit(card_id, id);`,
  `CREATE TABLE orchestrator_assignments (
    card_id INTEGER PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
    orchestrator_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('dispatching', 'assigned', 'error')),
    run_id INTEGER,
    attempts INTEGER NOT NULL DEFAULT 1,
    retry_after INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE orchestrator_lease (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );`,
  `ALTER TABLE agent_runs ADD COLUMN dispatch_key TEXT;
  CREATE UNIQUE INDEX agent_runs_dispatch_key ON agent_runs(dispatch_key) WHERE dispatch_key IS NOT NULL;
  ALTER TABLE orchestrator_assignments ADD COLUMN dispatch_key TEXT;`,
  `ALTER TABLE orchestrator_lease ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1;`,
  // An orchestrator's own chat CLI (PM-89): its board tools cover the master's projects.
  `ALTER TABLE agent_sessions ADD COLUMN orchestrator_id TEXT;`,
  // When you last sent the session a message (Enter or a pasted line), for the list sort (PM-94).
  `ALTER TABLE agent_sessions ADD COLUMN last_input_at TEXT;`,
  // Narrow Orchestrator live/review projections and last-served project lookup (PM-64).
  `CREATE INDEX agent_runs_live_projects ON agent_runs(project_id, id)
    WHERE status IN ('running', 'queued');
  CREATE INDEX agent_runs_pending_review ON agent_runs(project_id, id)
    WHERE status IN ('succeeded', 'failed') AND validation IS NULL;
  CREATE INDEX agent_runs_served_projects ON agent_runs(project_id, id)
    WHERE card_id IS NOT NULL;`,
  // Preserve master ownership independently of mutable assignment claims (PM-64).
  `ALTER TABLE agent_runs ADD COLUMN orchestrator_id TEXT;
  UPDATE agent_runs SET orchestrator_id = (
    SELECT a.orchestrator_id FROM orchestrator_assignments a
    WHERE a.run_id = agent_runs.id OR (a.dispatch_key IS NOT NULL AND a.dispatch_key = agent_runs.dispatch_key)
    LIMIT 1
  );
  CREATE INDEX agent_runs_orchestrator ON agent_runs(orchestrator_id, id);`,
  // Explicit GitHub issue identity for board lifecycle references (PM-64).
  `ALTER TABLE cards ADD COLUMN issue_url TEXT;`,
  // Stable manual request identity survives assignment replacement and response loss (PM-64).
  `CREATE TABLE orchestrator_dispatch_requests (
    orchestrator_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    card_id INTEGER NOT NULL,
    card_revision TEXT NOT NULL,
    dispatch_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (orchestrator_id, request_id)
  );`,
  // Immutable execution identity bridge; legacy runs remain explicitly unowned (PM-64).
  `CREATE TABLE agent_run_executions (
    nonce TEXT PRIMARY KEY,
    run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
    run_log_path TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK(attempt > 0),
    fingerprint TEXT NOT NULL,
    host_instance TEXT NOT NULL,
    host_generation INTEGER NOT NULL CHECK(host_generation > 0),
    dispatch_key TEXT,
    orchestrator_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(run_id, run_log_path, attempt)
  );`,
  `ALTER TABLE agent_runs ADD COLUMN execution_state TEXT CHECK(execution_state IN ('active','unknown','complete'));`,
  `CREATE TABLE agent_run_evidence (
    nonce TEXT PRIMARY KEY,
    cwd TEXT NOT NULL, baseline_at TEXT NOT NULL, baseline_json TEXT
  );`,
  `ALTER TABLE agent_runs ADD COLUMN execution_resolution_json TEXT;`,
  // Pinned files and folders on the Files tab (PM-284): one project's own (project_id set), or every
  // project's by relative path (project_id NULL). A path is unique per scope.
  `CREATE TABLE file_pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX file_pins_unique ON file_pins(COALESCE(project_id, 0), path);`,
];

export function openDb(dataDir: string): Db {
  const file = dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'projectmanager.db');
  if (file !== ':memory:') mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  repairSchema(db);
  makeCardProjectOptional(db);
  return db;
}

/**
 * Cards can belong to no project (PM-138, the "All projects" save target). Migration 1 created
 * cards.project_id as NOT NULL and SQLite cannot drop that in place, so the table is rebuilt.
 * Other tables reference cards(id), so the rebuild follows SQLite's documented procedure with
 * foreign_keys OFF — which must run outside migrate()'s transaction, because toggling the pragma
 * inside a transaction is a no-op. Idempotent: does nothing once project_id is already optional.
 */
function makeCardProjectOptional(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(cards)').all() as {
    name: string;
    notnull: number;
  }[];
  if (!columns.length) return;
  const projectId = columns.find((c) => c.name === 'project_id');
  if (!projectId || projectId.notnull === 0) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      CREATE TABLE cards_new (
        id            INTEGER PRIMARY KEY,
        project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        title         TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL
                      CHECK (status IN ('backlog', 'todo', 'in_progress', 'review', 'done')),
        position      REAL NOT NULL,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        closed_at     TEXT,
        linked_commit TEXT,
        issue_url     TEXT
      );
      INSERT INTO cards_new
        (id, project_id, title, description, status, position, created_at, updated_at, closed_at,
         linked_commit, issue_url)
        SELECT id, project_id, title, description, status, position, created_at, updated_at,
               closed_at, linked_commit, issue_url
        FROM cards;
      DROP TABLE cards;
      ALTER TABLE cards_new RENAME TO cards;
      CREATE INDEX cards_by_column ON cards (project_id, status, position);
    `);
    const broken = db.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error(`cards rebuild would break ${broken.length} reference(s)`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  console.warn('[db] rebuilt cards so a card can belong to no project');
}

/**
 * Columns that were added to an already-shipped migration during early development. Databases
 * created before the change ran the old version of that migration and are marked as migrated,
 * so they lack these columns ("table agent_sessions has no column named resume_json").
 * Repair is idempotent: a column is added only where it is missing. Don't grow this list; new
 * columns belong in a new migration.
 */
const LATE_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'agent_sessions', column: 'resume_json', definition: 'TEXT' },
];

export function repairSchema(db: Db): void {
  // Early execution tables predate per-attempt identities. Rebuild to replace their
  // UNIQUE(run_id, run_log_path) constraint as well as adding the missing column.
  const executionColumns = db.prepare('PRAGMA table_info(agent_run_executions)').all() as {
    name: string;
  }[];
  if (executionColumns.length && !executionColumns.some((c) => c.name === 'attempt')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`ALTER TABLE agent_run_executions RENAME TO agent_run_executions_legacy`);
      db.exec(MIGRATIONS.find((sql) => sql.startsWith('CREATE TABLE agent_run_executions ('))!);
      db.exec(`INSERT INTO agent_run_executions
        (nonce,run_id,run_log_path,attempt,fingerprint,host_instance,host_generation,dispatch_key,orchestrator_id,created_at)
        SELECT nonce,run_id,run_log_path,1,fingerprint,host_instance,host_generation,dispatch_key,orchestrator_id,created_at
        FROM agent_run_executions_legacy;
        DROP TABLE agent_run_executions_legacy;`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  for (const { table, column, definition } of LATE_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.length === 0 || columns.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.warn(`[db] repaired schema: added ${table}.${column}`);
  }
}

function migrate(db: Db): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
