import { createHash } from 'node:crypto';
import type { Db } from '../db.js';
import type { AgentSession } from '../../shared/types.js';
import type { OrchestratorConfig } from '../../shared/orchestrator.js';
import type { ProviderLimits } from '../../shared/limits.js';
import { getCard, getSetting, setSetting } from '../store.js';
import { AgentError, type AgentSupervisor } from '../agents/supervisor.js';
import { emptyCodexPrompt, emptyGrokPrompt } from '../agents/continuation.js';
import { stripTerminal } from '../agents/activity.js';
import { readLimits } from '../agents/limits.js';
import { antigravityAccounts, refreshAntigravityAccount } from '../agents/antigravityAccounts.js';
import type { AntigravityAccountsState } from '../../shared/antigravityAccounts.js';
import { planOrchestration } from './planner.js';
import { planningRuns } from './planningRuns.js';
import { enrollmentKey, orchestratorSessionIds, ownedSessionIds } from './ownedWorkers.js';
import { sessionLabel } from '../../shared/sessionLabel.js';

interface Enrollment {
  owner: string;
  cardId: number;
  enabled: boolean;
  token?: string;
  sentAt?: number;
}
export interface SessionReadiness {
  sessionId: number;
  name: string;
  /** Name with number, the way the owner reads sessions (PM-607). */
  label: string;
  projectId: number;
  cardId: number | null;
  cardKey: string | null;
  status: string;
  state: AgentSession['tailState'];
  lastOutputAt: string | null;
  supervised: boolean;
  canContinue: boolean;
  canWake: boolean;
  reason: string;
  progress: string;
}
const key = enrollmentKey;
export function sessionQuota(
  policy: OrchestratorConfig,
  providerId: string,
  limits: ProviderLimits[],
  now: number,
): string | null {
  const quota = limits.find((q) => q.providerId === providerId);
  if (
    !quota?.windows.length ||
    !Number.isFinite(Date.parse(quota.asOf)) ||
    Date.parse(quota.asOf) > now ||
    now - Date.parse(quota.asOf) > policy.quotaMaxAgeMs
  )
    return 'Quota is missing or stale';
  if (
    quota.windows.some(
      (w) =>
        w.resetSinceReport ||
        (w.resetsAt &&
          (!Number.isFinite(Date.parse(w.resetsAt)) || Date.parse(w.resetsAt) <= now)) ||
        !Number.isFinite(w.usedPercent) ||
        w.usedPercent < 0 ||
        w.usedPercent > 100,
    )
  )
    return 'Quota needs a fresh reading after reset or invalid usage';
  if (quota.windows.some((w) => w.usedPercent >= 100 - policy.reservePercent))
    return `Quota is at the ${policy.reservePercent}% reserve`;
  return null;
}
/** The live Antigravity login's quota, when its reading is fresh. */
function agyReading(state: AntigravityAccountsState): ProviderLimits | null {
  const account = state.defaultAccount;
  return account?.usageStatus === 'fresh' && account.limits
    ? { ...account.limits, providerId: 'antigravity' }
    : null;
}
export class SessionSupervision {
  private quotaReads = new Map<string, number>();
  private waking = new Set<number>();
  private cursors = new Map<string, number>();
  // The live Antigravity login's last fresh reading (PM-415). Reading it spawns a credential
  // bridge, so check() fetches it at most once a minute and inspect() uses the copy.
  private agyLimits: ProviderLimits | null = null;
  constructor(
    private db: Db,
    private supervisor: AgentSupervisor,
    private dataDir: string | null,
    private policy: (id: string) => OrchestratorConfig | undefined,
    private event: (id: string, action: string, message: string, cardId?: number) => void,
    private antigravity: {
      state(): Promise<AntigravityAccountsState>;
      refresh(): Promise<AntigravityAccountsState>;
    } = {
      state: () => antigravityAccounts(),
      refresh: () => refreshAntigravityAccount('default'),
    },
  ) {}
  private scoped(owner: string, id: number) {
    const policy = this.policy(owner);
    if (!policy) throw new AgentError(404, 'Orchestrator not found');
    const session = this.supervisor.getSession(id);
    if (
      !session ||
      session.orchestratorId ||
      (policy.projectIds.length && !policy.projectIds.includes(session.projectId)) ||
      !policy.providers.includes(session.providerId)
    )
      throw new AgentError(404, 'Session is not a worker in this orchestrator scope');
    return { policy, session };
  }
  assertCanEnroll(owner: string, id: number) {
    const { policy } = this.scoped(owner, id);
    const record = getSetting<Enrollment>(this.db, key(id));
    if (record?.enabled && record.owner !== owner && this.policy(record.owner))
      throw new AgentError(409, 'Session is already supervised by another orchestrator');
    if (
      !policy.superviseSessions ||
      policy.delegateToSessions === false ||
      policy.strategy === 'observe'
    )
      throw new AgentError(409, 'Enable autonomous session supervision and delegation first');
  }
  enroll(owner: string, id: number, enabled: boolean) {
    const { session } = this.scoped(owner, id);
    const previous = getSetting<Enrollment>(this.db, key(id));
    if (previous?.enabled && previous.owner !== owner && this.policy(previous.owner))
      throw new AgentError(409, 'Session is already supervised by another orchestrator');
    if (enabled) this.assertCanEnroll(owner, id);
    if (enabled && !session.cardId)
      throw new AgentError(409, 'Assign a card before enabling session supervision');
    setSetting(this.db, key(id), {
      ...(previous?.cardId === session.cardId ? previous : {}),
      owner,
      cardId: session.cardId ?? 0,
      enabled,
    } satisfies Enrollment);
    this.event(
      owner,
      enabled ? 'session-enrolled' : 'session-released',
      `${sessionLabel(session)} ${enabled ? 'enrolled for automatic continuation' : 'released from automatic continuation'}`,
      session.cardId ?? undefined,
    );
    return this.inspect(owner, id);
  }
  private quota(session: AgentSession): ProviderLimits[] {
    // Grok (PM-413): the live login's billing reading. Grok sessions use the login that was live
    // when they started; rotation restarts them on a switch, a manual switch asks the user to.
    if (session.providerId === 'grok') {
      try {
        const account = this.supervisor.grokAccounts?.state().defaultAccount;
        return account?.usageStatus === 'fresh' && account.limits
          ? [{ ...account.limits, providerId: 'grok' }]
          : [];
      } catch {
        return [];
      }
    }
    // Antigravity (PM-415): likewise the live login, as check() last read it.
    if (session.providerId === 'antigravity') return this.agyLimits ? [this.agyLimits] : [];
    if (session.providerId !== 'codex' && session.providerId !== 'claude')
      return readLimits(this.dataDir);
    try {
      const state =
        session.providerId === 'codex'
          ? this.supervisor.codexAccountsState()
          : this.supervisor.claudeAccountsState();
      const account =
        session.providerId === 'codex'
          ? session.codexAccountId === 'default'
            ? state.defaultAccount
            : state.accounts.find((a) => a.id === session.codexAccountId)
          : state.defaultAccount;
      return account?.usageStatus === 'fresh' && account.limits
        ? [{ ...account.limits, providerId: session.providerId }]
        : [];
    } catch {
      return [];
    }
  }
  inspect(owner: string, id: number): SessionReadiness {
    const { policy, session: s } = this.scoped(owner, id);
    const now = Date.now();
    const record = getSetting<Enrollment>(this.db, key(id));
    const card = s.cardId ? getCard(this.db, s.cardId) : null;
    const screen = s.status === 'running' ? this.supervisor.sessionScreen(id, 8000) : null;
    const progress = stripTerminal(screen ?? '').slice(-3000);
    let reason = 'Ready to continue';
    let canContinue = false;
    let canWake = false;
    const blocked =
      record?.enabled && record.owner !== owner && this.policy(record.owner)
        ? 'Another orchestrator owns session supervision'
        : !policy.enabled
          ? 'Orchestrator is paused'
          : policy.strategy === 'observe'
            ? 'Watch-only orchestrator'
            : policy.delegateToSessions === false
              ? 'Delegation is off'
              : !card || card.projectId !== s.projectId || card.status !== 'in_progress'
                ? 'Assigned card is not in progress'
                : !['codex', 'claude', 'grok', 'opencode', 'antigravity'].includes(s.providerId)
                  ? 'Not an AI CLI'
                  : sessionQuota(policy, s.providerId, this.quota(s), now);
    if (blocked) reason = blocked;
    else if (s.status !== 'running') {
      reason = 'Stopped session can be woken explicitly';
      canWake = true;
    } else if (s.tailState !== 'idle')
      reason =
        s.tailState === 'input'
          ? 'Waiting for owner input'
          : 'Session is working or its state is unknown';
    else if (s.question) reason = 'Session has a question for the owner';
    else if (s.queuedInputBytes > 0) reason = 'Session has queued input';
    else if (
      s.usageLimit ||
      s.autoContinue?.resumesAt ||
      // "quota reached" is Antigravity's ("⚠ Individual quota reached. … Resets in 25h…").
      /(?:hit.{0,20}(?:usage|rate|weekly|daily).{0,10}limit|auto.?continue.{0,30}(?:wait|reset)|usage limit|quota reached)/i.test(
        progress,
      )
    )
      reason = 'Provider quota/reset continuation owns this wait';
    else if (
      !screen ||
      !(s.providerId === 'grok' ? emptyGrokPrompt(screen) : emptyCodexPrompt(screen))
    )
      reason = 'Prompt is unreadable or contains a draft';
    else if (record?.sentAt && now - record.sentAt < 60_000)
      reason = 'Waiting for the previous continuation';
    else if (record?.token === this.token(s, progress))
      reason = 'No new progress since the previous continuation';
    else canContinue = true;
    return {
      sessionId: id,
      name: s.name,
      label: sessionLabel(s),
      projectId: s.projectId,
      cardId: s.cardId,
      cardKey: s.cardKey,
      status: s.status,
      state: s.tailState,
      lastOutputAt: s.lastOutputAt,
      supervised: record?.enabled === true && record.owner === owner && record.cardId === s.cardId,
      canContinue,
      canWake,
      reason,
      progress,
    };
  }
  async check(owner: string, id: number) {
    const { policy, session } = this.scoped(owner, id);
    const quotaKey = `${session.providerId}:${session.codexAccountId ?? 'default'}`;
    if (
      sessionQuota(policy, session.providerId, this.quota(session), Date.now()) &&
      Date.now() - (this.quotaReads.get(quotaKey) ?? 0) >= 60_000
    ) {
      this.quotaReads.set(quotaKey, Date.now());
      if (this.quotaReads.size > 100) this.quotaReads.delete(this.quotaReads.keys().next().value!);
      try {
        if (session.providerId === 'codex')
          await this.supervisor.refreshCodexAccountsUsage(session.codexAccountId ?? undefined);
        else if (session.providerId === 'claude')
          await this.supervisor.refreshClaudeAccountsUsage();
        else if (session.providerId === 'grok')
          await this.supervisor.grokAccounts?.refresh('default');
        else if (session.providerId === 'antigravity') {
          this.agyLimits = agyReading(await this.antigravity.state());
          if (!this.agyLimits) this.agyLimits = agyReading(await this.antigravity.refresh());
        }
      } catch {
        /* A failed refresh cannot authorize continuation. */
        if (session.providerId === 'antigravity') this.agyLimits = null;
      }
    }
    return this.inspect(owner, id);
  }
  private token(session: AgentSession, screen: string) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          session.startedAt,
          session.cardId,
          screen
            .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '[time]')
            .replace(/\b\d+[hms]\b/g, '[elapsed]'),
        ]),
      )
      .digest('hex');
  }
  continue(owner: string, id: number, automatic = false) {
    const { policy, session } = this.scoped(owner, id);
    const state = this.inspect(owner, id);
    const record = getSetting<Enrollment>(this.db, key(id));
    if (
      automatic &&
      (!policy.superviseSessions ||
        !record?.enabled ||
        record.owner !== owner ||
        record.cardId !== session.cardId)
    )
      throw new AgentError(409, 'Session is not enrolled for this card');
    if (!state.canContinue) throw new AgentError(409, state.reason);
    // Persist before writing. An uncertain acknowledgement must not cause a second Enter.
    setSetting(this.db, key(id), {
      owner,
      cardId: session.cardId!,
      enabled: record?.enabled === true,
      token: this.token(session, state.progress),
      sentAt: Date.now(),
    } satisfies Enrollment);
    const prompt = `Continue the unfinished work on ${session.cardKey}. Check the card requirements and current changes, preserve existing work, verify the result and move the card to Review only with evidence. If blocked or needing a decision, report it and stop.`;
    let result: ReturnType<AgentSupervisor['sendInput']>;
    try {
      result = this.supervisor.sendInput(id, `\x1b[200~${prompt}\x1b[201~\r`, false);
    } catch (error) {
      this.event(
        owner,
        'session-delivery-unknown',
        `${sessionLabel(session)}: continuation delivery is uncertain; inspect worker_output before retrying`,
        session.cardId ?? undefined,
      );
      throw error;
    }
    this.event(
      owner,
      'session-continued',
      `${sessionLabel(session)} continued on ${session.cardKey}`,
      session.cardId ?? undefined,
    );
    return {
      sent: true,
      queued: result.queued,
      sessionId: id,
      label: sessionLabel(session),
      delivery: 'Check worker_output before retrying',
    };
  }
  async wake(owner: string, id: number) {
    if (this.waking.has(id)) throw new AgentError(409, 'Session wake is already in progress');
    const initial = this.inspect(owner, id);
    if (!initial.canWake) throw new AgentError(409, initial.reason);
    const { policy, session } = this.scoped(owner, id);
    const card = getCard(this.db, session.cardId!)!;
    const sessions = this.supervisor
      .listAllSessions()
      .filter((s) => !s.orchestratorId)
      .map((s) => (this.waking.has(s.id) ? { ...s, status: 'running' as const } : s));
    const decision = planOrchestration(
      { ...policy, providers: [session.providerId], allowUnknownQuota: false },
      {
        workerKind: 'session',
        cards: [card],
        runs: planningRuns(this.db, policy.projectIds),
        // Resuming reuses this saved CLI slot rather than creating another one.
        sessions: sessions.filter((s) => s.id !== id),
        ownedSessionIds: ownedSessionIds(this.db, owner, sessions),
        orchestratorSessionIds: orchestratorSessionIds(this.db, sessions),
        availableProviders: [session.providerId],
        limits: this.quota(session),
      },
    )[0];
    if (decision?.action !== 'dispatch')
      throw new AgentError(409, decision?.reason ?? 'Worker capacity is unavailable');
    if (!this.inspect(owner, id).canWake)
      throw new AgentError(409, 'Session state changed; check again');
    this.waking.add(id);
    let resumed: AgentSession;
    try {
      resumed = await this.supervisor.startSession(id);
    } finally {
      this.waking.delete(id);
    }
    this.event(
      owner,
      'session-woken',
      `${sessionLabel(session)} resumed; inspect it before continuing`,
      session.cardId ?? undefined,
    );
    return {
      sessionId: resumed.id,
      label: sessionLabel(resumed),
      status: resumed.status,
      note: 'Conversation resumed; check readiness before sending another instruction',
    };
  }
  async tick(owner: string, alive: () => boolean = () => true) {
    const policy = this.policy(owner);
    if (
      !policy?.enabled ||
      !policy.superviseSessions ||
      policy.strategy === 'observe' ||
      policy.delegateToSessions === false
    )
      return;
    const sessions = this.supervisor.listAllSessions().filter((session) => {
      const record = getSetting<Enrollment>(this.db, key(session.id));
      return record?.enabled && record.owner === owner;
    });
    const offset = (this.cursors.get(owner) ?? 0) % Math.max(1, sessions.length);
    this.cursors.set(owner, offset + 50);
    for (let index = 0; index < Math.min(50, sessions.length); index++) {
      const session = sessions[(offset + index) % sessions.length]!;
      try {
        if (!alive()) return;
        const state = await this.check(owner, session.id);
        if (alive() && state.canContinue) this.continue(owner, session.id, true);
      } catch (error) {
        if (!(error instanceof AgentError)) console.error('[orchestrator-supervision]', error);
      }
    }
  }
}
