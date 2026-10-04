// Runs project scans in the background and keeps their status in memory. Scans can take from
// milliseconds to a minute on huge folders, so HTTP handlers start them and the UI polls.

import type { CardMove, ScanState } from '../shared/types.js';
import { computeMoves } from './analysis/cardRefs.js';
import { scanCode } from './analysis/codeScan.js';
import { scanDisk } from './analysis/diskScan.js';
import { commitMessagesSince, scanGit } from './analysis/git.js';
import type { Db } from './db.js';
import { getProjectRow, listCards, moveCardToTop, saveScanResults } from './store.js';

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

    // Card references: only look at commits newer than the cursor, so a card the user moved back
    // by hand isn't moved again by the same old commit on every refresh.
    let moves: CardMove[] = [];
    let refsCursor = project.refs_cursor;
    const openCards = listCards(this.db, projectId).filter((c) => c.status !== 'done');
    if (git.isRepo && openCards.length > 0) {
      // Timestamps carry different UTC offsets, so compare parsed values, never strings.
      const oldestCard = Math.min(...openCards.map((c) => Date.parse(c.createdAt)));
      const cursor = refsCursor ? Date.parse(refsCursor) : -Infinity;
      const since = new Date(Math.max(cursor, oldestCard)).toISOString();
      const commits = (await commitMessagesSince(project.path, since)).filter(
        (c) => Date.parse(c.committedAt) > cursor,
      );
      moves = computeMoves(openCards, commits);
      if (commits.length > 0) refsCursor = commits.at(-1)!.committedAt;
    } else if (git.lastCommitAt && !refsCursor) {
      refsCursor = new Date().toISOString();
    }

    // Re-check: the project may have been deleted while scanning.
    if (!getProjectRow(this.db, projectId)) return [];
    for (const move of moves) moveCardToTop(this.db, move.cardId, move.to, move.commit);
    saveScanResults(this.db, projectId, { code, disk, git, refsCursor });

    console.log(
      `[scan] ${project.name}: ${code.code} LOC, ${disk.files} files, ${git.totalCommits} commits` +
        `${moves.length ? `, ${moves.length} card(s) moved` : ''} (${Date.now() - started} ms)`,
    );
    return moves;
  }
}
