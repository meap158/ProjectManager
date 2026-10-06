// Runs project scans in the background and keeps their status in memory. Scans can take from
// milliseconds to a minute on huge folders, so HTTP handlers start them and the UI polls.

import { existsSync } from 'node:fs';
import type { CardMove, ScanState } from '../shared/types.js';
import { computeMoves } from './analysis/cardRefs.js';
import { scanCode } from './analysis/codeScan.js';
import { scanDisk } from './analysis/diskScan.js';
import { commitMessagesSince, headCommit, scanGit } from './analysis/git.js';
import type { Db } from './db.js';
import {
  getProjectRow,
  getSetting,
  listCards,
  listProjectFolders,
  stalestProject,
  moveCardToTop,
  saveScanResults,
  setRefsCursor,
  setSetting,
} from './store.js';

const IDLE: ScanState = { status: 'idle', error: null, startedAt: null, moves: [] };

export class Scanner {
  private states = new Map<number, ScanState>();

  constructor(private db: Db) {}

  state(projectId: number): ScanState {
    return this.states.get(projectId) ?? IDLE;
  }

  forget(projectId: number): void {
    this.states.delete(projectId);
  }

  /** Starts a scan unless one is already running. Returns immediately. */
  start(projectId: number): void {
    if (this.state(projectId).status === 'scanning') return;
    this.states.set(projectId, {
      status: 'scanning',
      error: null,
      startedAt: new Date().toISOString(),
      moves: [],
    });
    this.run(projectId).then(
      (moves) => this.states.set(projectId, { ...IDLE, moves }),
      (error: Error) => {
        console.error(`[scan] project ${projectId} failed:`, error);
        this.states.set(projectId, { ...IDLE, status: 'error', error: error.message });
      },
    );
  }

  private async run(projectId: number): Promise<CardMove[]> {
    const started = Date.now();
    const project = getProjectRow(this.db, projectId);
    if (!project) return [];

    const [code, disk, git] = await Promise.all([
      scanCode(project.path),
      scanDisk(project.path),
      scanGit(project.path),
    ]);

    // Card references (shared with the commit watcher, so cards follow commits without a scan).
    if (!getProjectRow(this.db, projectId)) return [];
    const moves = git.isRepo ? await this.applyCommitRefs(projectId) : [];
    const refsCursor = getProjectRow(this.db, projectId)?.refs_cursor ?? null;

    // Re-check: the project may have been deleted while scanning.
    if (!getProjectRow(this.db, projectId)) return [];
    saveScanResults(this.db, projectId, { code, disk, git, refsCursor });

    console.log(
      `[scan] ${project.name}: ${code.code} LOC, ${disk.files} files, ${git.totalCommits} commits` +
        `${moves.length ? `, ${moves.length} card(s) moved` : ''} (${Date.now() - started} ms)`,
    );
    return moves;
  }

  /**
   * Applies card references from commits not yet seen: "PM-12" moves a Backlog/To do card to In
   * progress, "Fixes PM-12" (closes/resolves/completes) moves it to Done. A cursor (last applied
   * commit time, plus the hashes seen at exactly that time) makes this idempotent, so a card moved
   * back by hand isn't moved again by an old commit, and two commits in the same second both count.
   */
  async applyCommitRefs(projectId: number): Promise<CardMove[]> {
    const project = getProjectRow(this.db, projectId);
    if (!project) return [];
    const seenKey = `refs_seen:${projectId}`;
    const seen = new Set(getSetting<string[]>(this.db, seenKey) ?? []);
    const cursor = project.refs_cursor ? Date.parse(project.refs_cursor) : -Infinity;
    const openCards = listCards(this.db, projectId).filter((c) => c.status !== 'done');
    if (openCards.length === 0) {
      // Nothing to move: just keep the cursor at "now" so old history never replays later.
      if (!project.refs_cursor) setRefsCursor(this.db, projectId, new Date().toISOString());
      return [];
    }
    // Timestamps carry different UTC offsets, so compare parsed values, never strings.
    const oldestCard = Math.min(...openCards.map((c) => Date.parse(c.createdAt)));
    const since = new Date(Math.max(cursor, oldestCard) - 1000).toISOString();
    const commits = (await commitMessagesSince(project.path, since)).filter((c) => {
      const at = Date.parse(c.committedAt);
      return at > cursor || (at === cursor && !seen.has(c.hash));
    });
    if (commits.length === 0) return [];
    const moves = computeMoves(openCards, commits);
    if (!getProjectRow(this.db, projectId)) return [];
    for (const move of moves) moveCardToTop(this.db, move.cardId, move.to, move.commit);
    const last = commits.at(-1)!.committedAt;
    const lastAt = Date.parse(last);
    const atLast = commits.filter((c) => Date.parse(c.committedAt) === lastAt).map((c) => c.hash);
    setRefsCursor(this.db, projectId, last);
    setSetting(this.db, seenKey, lastAt === cursor ? [...seen, ...atLast] : atLast);
    if (moves.length > 0) {
      console.log(
        `[cards] project ${projectId}: ${moves.map((m) => `${m.key} → ${m.to}`).join(', ')}`,
      );
    }
    return moves;
  }

  /**
   * Keeps every project's stats fresh without a manual Refresh: every `checkMs` the project
   * scanned longest ago is rescanned once it is older than `maxAgeMs`. One scan at a time, so
   * big folders never pile up on a busy machine. Returns a stop function.
   */
  refreshPeriodically(maxAgeMs = 15 * 60_000, checkMs = 60_000): () => void {
    const tick = () => {
      if ([...this.states.values()].some((s) => s.status === 'scanning')) return;
      const stalest = stalestProject(this.db);
      if (!stalest || !existsSync(stalest.path)) return;
      const age = stalest.last_scanned_at
        ? Date.now() - Date.parse(stalest.last_scanned_at)
        : Infinity;
      if (age >= maxAgeMs) this.start(stalest.id);
    };
    const timer = setInterval(tick, checkMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /**
   * Keeps boards in step with commits without a manual Refresh: every `intervalMs` each project's
   * HEAD is checked (one cheap `git rev-parse`), and when it changed, only the new commits'
   * card references are applied. Returns a stop function.
   */
  watchCommits(intervalMs = 15_000): () => void {
    const heads = new Map<number, string | null>();
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const { id, path } of listProjectFolders(this.db)) {
          if (this.state(id).status === 'scanning') continue;
          const head = await headCommit(path);
          if (!head || heads.get(id) === head) continue;
          heads.set(id, head);
          await this.applyCommitRefs(id).catch((e: Error) =>
            console.error(`[cards] project ${id}: ${e.message}`),
          );
        }
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}
