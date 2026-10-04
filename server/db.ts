import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

// Append-only list of migrations; the index + 1 is stored in PRAGMA user_version.
// Never edit a migration that has shipped — add a new one.
const MIGRATIONS: string[] = [
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
];

export function openDb(dataDir: string): Db {
  const file = dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'projectmanager.db');
  if (file !== ':memory:') mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
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
