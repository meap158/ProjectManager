// Runs project scans in the background and keeps their status in memory. Scans can take from
// milliseconds to a minute on huge folders, so HTTP handlers start them and the UI polls.

import { existsSync } from 'node:fs';
import { CARD_KEY_PREFIX, type CardMove, type ScanState } from '../shared/types.js';
import { issueReferenceEvents } from './analysis/issueRefs.js';
import { commitEvents, computeMoves, type RefEvent } from './analysis/cardRefs.js';
import { scanCode } from './analysis/codeScan.js';
import { scanDisk } from './analysis/diskScan.js';
import {
  branchesFingerprint,
  commitMessagesSince,
  defaultBranch,
  localBranches,
  originUrl,
  scanGit,
} from './analysis/git.js';
import { ghAccountSettingKey } from './ghAccount.js';
import { pullRequestEvents } from './pullRequests.js';
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

/** Card keys anywhere in a text (cheap pre-filter before the full rules). */
const MENTIONS_CARD = new RegExp(String.raw`\b${CARD_KEY_PREFIX}-\d+\b`, 'i');
/** Applied events remembered per project (newest kept). */
const MAX_SEEN = 5000;
const seenKey = (projectId: number) => `ref_events_seen:${projectId}`;

/**
 * Scans doing work at once. Each one walks the folder, reads every source file and runs scc and
 * git, so adding many projects at once would otherwise start them all together.
 */
const MAX_PARALLEL_SCANS = 2;

const IDLE: ScanState = { status: 'idle', error: null, startedAt: null, moves: [] };

export class Scanner {
  private states = new Map<number, ScanState>();
  private runningScans = 0;
  private waitingScans: (() => void)[] = [];

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
    this.inTurn(() => this.run(projectId)).then(
      (moves) => this.states.set(projectId, { ...IDLE, moves }),
      (error: Error) => {
        console.error(`[scan] project ${projectId} failed:`, error);
        this.states.set(projectId, { ...IDLE, status: 'error', error: error.message });
      },
    );
  }

  /** Runs `task` once fewer than MAX_PARALLEL_SCANS scans are working (first come, first served). */
  private async inTurn<T>(task: () => Promise<T>): Promise<T> {
    if (this.runningScans < MAX_PARALLEL_SCANS) this.runningScans++;
    else await new Promise<void>((resolve) => this.waitingScans.push(resolve));
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiting scan, or give it back.
      const next = this.waitingScans.shift();
      if (next) next();
      else this.runningScans--;
    }
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
   * Moves cards from what git records, on every local branch (see analysis/cardRefs.ts for the
   * rules): default-branch commits, commits only on other branches (worktrees, feature branches)
   * and branch names. Each event is applied once (a seen-set in settings), so a card moved back
   * by hand stays put and a branch commit counts again only once it is merged.
   */
  async applyCommitRefs(projectId: number): Promise<CardMove[]> {
    const project = getProjectRow(this.db, projectId);
    if (!project) return [];
    const since = this.lookback(projectId);
    if (!since) return [];
    const main = await defaultBranch(project.path);
    const [merged, branchOnly, branches] = await Promise.all([
      commitMessagesSince(project.path, since, main ? [main] : []),
      main
        ? commitMessagesSince(project.path, since, ['--branches', '--not', main])
        : Promise.resolve([]),
      localBranches(project.path),
    ]);
    const events: RefEvent[] = [
      ...commitEvents(merged, 'commit'),
      ...commitEvents(branchOnly, 'branch-commit'),
      ...branches
        .filter((b) => b.name !== main)
        .map((b): RefEvent => ({
          id: `branch:${b.name}`,
          kind: 'branch',
          // A new branch usually points at an older commit, but a branch named after a card can
          // only exist because the card does: date it when first seen, not by its tip.
          at: new Date(Math.max(Date.parse(b.at), Date.now())).toISOString(),
          text: b.name,
          source: b.name,
        })),
    ];
    return this.applyEvents(projectId, [
      ...events,
      ...issueReferenceEvents(listCards(this.db, projectId), events, await originUrl(project.path)),
    ]);
  }

  /** Moves cards from the project's pull requests on GitHub (open → Review, merged → Done). */
  async applyPullRequestRefs(projectId: number): Promise<CardMove[] | null> {
    const project = getProjectRow(this.db, projectId);
    if (!project || !this.lookback(projectId)) return [];
    const events = await pullRequestEvents(
      project.path,
      getSetting<string>(this.db, ghAccountSettingKey(projectId)),
    );
    return events
      ? this.applyEvents(projectId, [
          ...events,
          ...issueReferenceEvents(
            listCards(this.db, projectId),
            events,
            await originUrl(project.path),
          ),
        ])
      : null;
  }

  /** Lower bound for history worth reading: the oldest open card (within 90 days). */
  private lookback(projectId: number): string | null {
    const open = listCards(this.db, projectId).filter((c) => c.status !== 'done');
    if (open.length === 0) return null;
    const oldest = Math.min(...open.map((c) => Date.parse(c.createdAt)));
    return new Date(Math.max(oldest, Date.now() - 90 * 86_400_000) - 1000).toISOString();
  }

  private applyEvents(projectId: number, all: RefEvent[]): CardMove[] {
    const project = getProjectRow(this.db, projectId);
    if (!project) return [];
    const seen = this.seenEvents(projectId, all);
    // Only events that name a card matter (and are remembered); the rest are skipped cheaply.
    const fresh = all.filter((e) => !seen.has(e.id) && MENTIONS_CARD.test(e.text));
    if (fresh.length === 0) return [];
    const openCards = listCards(this.db, projectId).filter((c) => c.status !== 'done');
    const moves = computeMoves(openCards, fresh);
    for (const move of moves) moveCardToTop(this.db, move.cardId, move.to, move.commit);
    for (const e of fresh) seen.add(e.id);
    setSetting(this.db, seenKey(projectId), [...seen].slice(-MAX_SEEN));
    const latest = fresh
      .map((e) => e.at)
      .sort((a, b) => Date.parse(a) - Date.parse(b))
      .at(-1)!;
    if (!project.refs_cursor || Date.parse(latest) > Date.parse(project.refs_cursor))
      setRefsCursor(this.db, projectId, latest);
    if (moves.length > 0) {
      console.log(
        `[cards] project ${projectId}: ${moves.map((m) => `${m.key} → ${m.to}`).join(', ')}`,
      );
    }
    return moves;
  }

  /**
   * Events already applied. First run after the move from the old time cursor: everything at or
   * before that cursor counts as applied, so old history never replays.
   */
  private seenEvents(projectId: number, events: RefEvent[]): Set<string> {
    const saved = getSetting<string[]>(this.db, seenKey(projectId));
    if (saved) return new Set(saved);
    const cursor = getProjectRow(this.db, projectId)?.refs_cursor;
    const legacy = new Set(getSetting<string[]>(this.db, `refs_seen:${projectId}`) ?? []);
    const seen = new Set<string>();
    for (const e of events) {
      const old = cursor && Date.parse(e.at) < Date.parse(cursor);
      const sameSecondSeen =
        cursor && Date.parse(e.at) === Date.parse(cursor) && legacy.has(e.source);
      if (old || sameSecondSeen) seen.add(e.id);
    }
    return seen;
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
          // Any local branch moving counts (worktrees and feature branches, not just HEAD).
          const head = await branchesFingerprint(path);
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

  /**
   * Pull requests on GitHub move cards too (open → Review, merged → Done): polled every
   * `intervalMs` for projects with a GitHub remote, via the gh CLI. A project whose gh call fails
   * (not installed, not signed in) is skipped for 30 minutes. Returns a stop function.
   */
  watchPullRequests(intervalMs = 120_000): () => void {
    const retryAt = new Map<number, number>();
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const { id, path } of listProjectFolders(this.db)) {
          if ((retryAt.get(id) ?? 0) > Date.now()) continue;
          if (!/github\.com[:/]/i.test((await originUrl(path)) ?? '')) {
            retryAt.set(id, Date.now() + 30 * 60_000); // Re-check the remote now and then.
            continue;
          }
          const moves = await this.applyPullRequestRefs(id).catch(() => null);
          if (moves === null) retryAt.set(id, Date.now() + 30 * 60_000);
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
