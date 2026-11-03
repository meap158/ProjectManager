import type { Db } from '../db.js';
import type { OrchestratorConfig } from '../../shared/orchestrator.js';
import type { AgentSession } from '../../shared/types.js';
import { getSetting, listCardsInFlight, listSchedulableCards, setSetting } from '../store.js';
import { readLimits } from '../agents/limits.js';
import { ownedSessionIds } from './ownedWorkers.js';
import { sessionQuota } from './sessionSupervision.js';

/** Bounds on automatic checks (PM-418). */
export const AUTO_CHECK_MAX_PER_HOUR = 4;
export const AUTO_CHECK_MIN_GAP_MS = 5 * 60_000;
export const AUTO_CHECK_FALLBACK_MS = 30 * 60_000;
const HOUR_MS = 3_600_000;

/** What the last look saw; a trigger is a change against it. */
interface AutoCheckState {
  /** Timestamps (ms) of automatic checks within the last hour. */
  sent: number[];
  lastCheckAt: number;
  /** Owned sessions that were working. */
  running: number[];
  /** Cards that were in Review. */
  review: number[];
  /** Providers whose quota was usable (above the reserve). */
  quotaOk: string[];
}

interface Deps {
  db: Db;
  dataDir: string | null;
  listSessions: () => AgentSession[];
  policy: (id: string) => OrchestratorConfig | undefined;
  instances: () => OrchestratorConfig[];
  /** The chat's newest session, live or stopped. */
  chatSession: (id: string) => AgentSession | null;
  /** chat.check: it keeps its own 409 guards. */
  check: (id: string) => Promise<unknown>;
  record: (id: string, message: string) => void;
  now?: () => number;
}

const key = (id: string) => `orchestrator-auto-check:${id}`;

/**
 * Lets an opted-in orchestrator ask its own chat for the existing check when something changed in
 * scope. It never opens or restarts a chat, never types while the chat is busy, asking, or has
 * queued input, and is bounded by a per-hour count and a minimum gap. A trigger is the difference
 * between the persisted state and now. The state only advances fully when a check is sent, so a
 * deferred trigger stays pending, and a restart neither loses nor repeats one.
 */
export class AutoCheck {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  constructor(private deps: Deps) {}

  start(intervalMs = 30_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const instance of this.deps.instances()) {
        try {
          await this.consider(instance.id);
        } catch (e) {
          console.error('[orchestrator] auto check:', (e as Error).message);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async consider(id: string): Promise<void> {
    const { db } = this.deps;
    const now = (this.deps.now ?? Date.now)();
    const policy = this.deps.policy(id);
    // Off, paused or watch-only: forget the baseline, so turning it on starts from a fresh look.
    if (!policy?.autoCheck || !policy.enabled || policy.strategy === 'observe') {
      if (getSetting(db, key(id)) !== null) setSetting(db, key(id), null);
      return;
    }
    const current = this.observe(policy, now);
    const previous = getSetting<AutoCheckState>(db, key(id));
    if (!previous) {
      this.save(id, { ...current.state, sent: [], lastCheckAt: now });
      return;
    }
    const triggers: string[] = [];
    for (const sessionId of previous.running)
      if (!current.state.running.includes(sessionId))
        triggers.push(`session ${sessionId} stopped working`);
    for (const cardId of current.state.review)
      if (!previous.review.includes(cardId)) triggers.push(`card ${cardId} moved to Review`);
    for (const p of current.state.quotaOk)
      if (!previous.quotaOk.includes(p)) triggers.push(`${p} quota recovered`);
    if (!triggers.length && current.pending && now - previous.lastCheckAt >= AUTO_CHECK_FALLBACK_MS)
      triggers.push('slow fallback, work is pending');

    const sent = previous.sent.filter((t) => now - t < HOUR_MS);
    if (!triggers.length) {
      // Nothing to report: follow the present, so a later change is measured against it.
      this.save(id, { ...current.state, sent, lastCheckAt: previous.lastCheckAt });
      return;
    }
    // Deferred triggers stay visible in the baseline until a check goes out.
    const deferred: AutoCheckState = {
      sent,
      lastCheckAt: previous.lastCheckAt,
      running: [...new Set([...previous.running, ...current.state.running])],
      review: previous.review.filter((c) => current.state.review.includes(c)),
      quotaOk: previous.quotaOk.filter((p) => current.state.quotaOk.includes(p)),
    };
    const chat = this.deps.chatSession(id);
    if (
      sent.length >= AUTO_CHECK_MAX_PER_HOUR ||
      now - previous.lastCheckAt < AUTO_CHECK_MIN_GAP_MS ||
      // A stopped (or never opened) chat stays the owner's choice.
      !chat ||
      chat.status !== 'running' ||
      chat.tailState === 'running' ||
      chat.tailState === 'input' ||
      chat.queuedInputBytes > 0
    ) {
      this.save(id, deferred);
      return;
    }
    try {
      await this.deps.check(id);
    } catch {
      this.save(id, deferred); // chat.check's own guards said no; the trigger stays pending.
      return;
    }
    this.deps.record(
      id,
      `Automatic check (${triggers.slice(0, 3).join('; ')}${triggers.length > 3 ? `; +${triggers.length - 3} more` : ''})`,
    );
    this.save(id, { ...current.state, sent: [...sent, now], lastCheckAt: now });
  }

  private save(id: string, state: AutoCheckState) {
    setSetting(this.deps.db, key(id), state);
  }

  private observe(policy: OrchestratorConfig, now: number) {
    const { db } = this.deps;
    const sessions = this.deps.listSessions().filter((s) => !s.orchestratorId);
    const owned = ownedSessionIds(db, policy.id, sessions);
    const running = sessions
      .filter((s) => owned.has(s.id) && s.status === 'running' && s.tailState === 'running')
      .map((s) => s.id);
    const cards = listCardsInFlight(db, policy.projectIds);
    const review = cards.filter((c) => c.status === 'review').map((c) => c.id);
    const limits = readLimits(this.deps.dataDir);
    const quotaOk = policy.providers.filter((p) => sessionQuota(policy, p, limits, now) === null);
    return {
      state: { running, review, quotaOk },
      pending: cards.length > 0 || listSchedulableCards(db, policy.projectIds).length > 0,
    };
  }
}
