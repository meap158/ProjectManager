import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { OrchestratorPending } from '../components/OrchestratorPending';
import { OrchestratorNextStep } from '../components/OrchestratorNextStep';
import { Dropdown } from '../components/Dropdown';
import { ConfirmDelete } from '../components/ConfirmDelete';
import { PROVIDER_LABELS } from '../components/icons';
import type { AgentSession, CardWithProject, ProjectSummary } from '../../../shared/types';
import type { OrchestratorConfig, OrchestratorState } from '../../../shared/orchestrator';
import { projectAttention } from '../../../shared/projectAttention';
import './orchestrator.css';
import { serialPoll } from '../lib/serialPoll';
import { RunCard } from '../components/RunCard';
import { useOrchestratorRuns } from '../components/useOrchestratorRuns';
import { OrchestratorChat } from '../components/OrchestratorChat';
import { collapseButtonProps, useCollapsed } from '../useCollapsed';

const defaults: Omit<OrchestratorConfig, 'id'> = {
  name: 'Orchestrator',
  enabled: false,
  projectIds: [],
  providers: ['codex', 'claude'],
  maxWorkers: 4,
  maxWorkersPerProject: 1,
  maxWorkersPerProvider: 2,
  reservePercent: 10,
  allowUnknownQuota: false,
  quotaMaxAgeMs: 3600000,
  followDashboardAttention: true,
  pruneDashboardAttention: true,
};

function actionBadgeClass(action: string): string {
  switch (action) {
    case 'dispatched':
      return 'badge badge-done';
    case 'dispatching':
      return 'badge badge-tracked';
    case 'error':
      return 'badge badge-danger';
    case 'review':
      return 'badge badge-attention';
    case 'pruned':
      return 'badge badge-done';
    case 'follow-up':
      return 'badge badge-attention';
    default:
      return 'badge';
  }
}

const WAIT_REASON_LABELS: Record<string, string> = {
  active_worker: 'In progress',
  review_required: 'Needs review',
  assignment_reserved: 'Reserved',
  retry_cooldown: 'Cooldown',
  retry_budget_exhausted: 'Budget exhausted',
  project_capacity: 'Project busy',
  managed_capacity: 'Worker limit',
  global_capacity: 'Host limit',
  provider_capacity: 'Provider limit',
  quota_exceeded: 'Quota reserve',
  quota_unknown: 'Quota unknown',
  no_provider_available: 'No provider',
};

function formatEventTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return isoString;
  }
}

export function OrchestratorPage() {
  const [state, setState] = useState<OrchestratorState>({ instances: [], events: [] });
  const [search, setSearch] = useSearchParams();
  const requestedOwner = search.get('orchestrator');
  const selectedInstance =
    state.instances.find((item) => item.id === requestedOwner) ?? state.instances[0];
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [runRefresh, setRunRefresh] = useState(0);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [inFlightCards, setInFlightCards] = useState<CardWithProject[]>([]);
  // Collapsed orchestrators and panels (PM-90), remembered in this browser.
  const { isCollapsed, toggle } = useCollapsed('pm.orchestrator.collapsed');
  const [draft, setDraft] = useState<Omit<OrchestratorConfig, 'id'> & { id?: string }>(defaults);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [actionResult, setActionResult] = useState<{
    message: string;
    cards: number[];
    runs: number[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const linkedRun = Number(search.get('run'));
  const runFeed = useOrchestratorRuns(
    selectedInstance?.id,
    runRefresh,
    busy,
    Number.isSafeInteger(linkedRun) && linkedRun > 0 ? linkedRun : undefined,
  );
  const runs = runFeed.runs;
  const [preview, setPreview] = useState<{
    id: string;
    data: Awaited<ReturnType<typeof api.previewOrchestrator>>;
  } | null>(null);
  const [historyFilter, setHistoryFilter] = useState<
    'all' | 'dispatched' | 'wait' | 'pruned' | 'error'
  >('all');
  const [historyLimit, setHistoryLimit] = useState(25);
  const refreshEpoch = useRef(0);
  const performing = useRef(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (performing.current) return;
      const epoch = ++refreshEpoch.current;
      const current = () => active && epoch === refreshEpoch.current && !performing.current;
      await Promise.all([
        api.orchestrators().then(
          (next) => {
            if (current()) {
              setState(next);
              setLoaded(true);
            }
          },
          (e: Error) => {
            if (current()) setError(e.message);
          },
        ),
        api.listProjects().then(
          (next) => {
            if (current()) setProjects(next);
          },
          () => {},
        ),
        api.listAllSessions().then(
          (next) => {
            if (current()) setSessions(next);
          },
          () => {},
        ),
        api.listCardsInFlight().then(
          (next) => {
            if (current()) setInFlightCards(next);
          },
          () => {},
        ),
      ]);
    };
    const stop = serialPoll(load, 5000);
    return () => {
      active = false;
      stop();
    };
  }, []);

  const perform = async (action: () => Promise<unknown>) => {
    if (performing.current) return;
    performing.current = true;
    refreshEpoch.current++;
    setBusy(true);
    setError('');
    setActionResult(null);
    try {
      await action();
      const [nextState, nextProjects, nextSessions, nextInFlight] = await Promise.all([
        api.orchestrators(),
        api.listProjects().catch(() => projects),
        api.listAllSessions().catch(() => sessions),
        api.listCardsInFlight().catch(() => inFlightCards),
      ]);
      setState(nextState);
      setProjects(nextProjects);
      setRunRefresh((value) => value + 1);
      setSessions(nextSessions);
      setInFlightCards(nextInFlight);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      performing.current = false;
      refreshEpoch.current++;
      setBusy(false);
    }
  };

  const resolvePending = (instance: OrchestratorConfig, projectId?: number) =>
    perform(async () => {
      const { result } = await (projectId
        ? api.resolveOrchestratorAttention(instance.id, projectId)
        : api.resolveOrchestratorAttention(instance.id));
      const count = result.dispatchedRuns.length;
      setActionResult({
        cards: result.resolvedCards,
        runs: result.dispatchedRuns,
        message: count
          ? `${count} run${count === 1 ? '' : 's'} dispatched. Results will need review.`
          : !result.resolvedCards.length
            ? 'No pending Dashboard issues found in this scope.'
            : !instance.enabled
              ? 'Follow-ups queued. This orchestrator is paused; start it to let it run them.'
              : instance.strategy === 'observe'
                ? 'Follow-ups queued. It is set to watch only; switch it to start workers to run them.'
                : 'Follow-ups queued; no worker started yet. Preview plan shows what is holding them.',
      });
    });
  const isFormVisible = showForm || Boolean(draft.id) || state.instances.length === 0;
  const hasRunning = state.instances.some((i) => i.enabled);

  const selectedEvents = state.events.filter(
    (event) => !selectedInstance || event.orchestratorId === selectedInstance.id,
  );
  const allCount = selectedEvents.length;
  const dispatchedCount = selectedEvents.filter(
    (e) => e.action === 'dispatched' || e.action === 'dispatching',
  ).length;
  const waitCount = selectedEvents.filter(
    (e) => e.action === 'wait' || e.action === 'review',
  ).length;
  const prunedCount = selectedEvents.filter((e) => e.action === 'pruned').length;
  const errorCount = selectedEvents.filter((e) => e.action === 'error').length;

  const filteredEvents = selectedEvents.filter((e) => {
    if (selectedInstance && e.orchestratorId !== selectedInstance.id) return false;
    if (historyFilter === 'dispatched')
      return e.action === 'dispatched' || e.action === 'dispatching';
    if (historyFilter === 'wait') return e.action === 'wait' || e.action === 'review';
    if (historyFilter === 'pruned') return e.action === 'pruned';
    if (historyFilter === 'error') return e.action === 'error';
    return true;
  });

  const reversedEvents = [...filteredEvents].reverse();
  const visibleEvents = reversedEvents.slice(0, historyLimit);

  return (
    <main className="page orchestrator-page">
      <div className="page-head">
        <div>
          <h1>Orchestrators</h1>
          <p className="faint orchestrator-intro">
            An orchestrator looks after a set of projects: it keeps their boards moving, starts
            agent workers on ready tasks within your limits, and shows what needs you. Chat with one
            to ask for anything.
          </p>
        </div>
        <Link className="btn btn-sm" to="/workspace">
          Agent terminals
        </Link>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      {actionResult && (
        <section className="panel orchestrator-action-result" aria-label="Action result">
          <p role="status">{actionResult.message}</p>
          <div className="orchestrator-result-links">
            {actionResult.cards.map((id) => (
              <Link key={id} className="btn btn-sm" to={`/board?card=${id}`}>
                Task PM-{id}
              </Link>
            ))}
            {actionResult.runs.map((id) => (
              <Link
                key={id}
                className="btn btn-sm"
                to={
                  runs.find((run) => run.id === id)?.cardId
                    ? `/board?card=${runs.find((run) => run.id === id)!.cardId}`
                    : '/workspace'
                }
              >
                Run #{id}
              </Link>
            ))}
            <button type="button" className="btn btn-sm" onClick={() => setActionResult(null)}>
              Dismiss result
            </button>
          </div>
        </section>
      )}

      {/* The orchestrators */}
      <section className="panel orchestrator-masters-panel">
        <div className="panel-header">
          <div className="panel-title-group">
            <h2>Your orchestrators</h2>
            {state.instances.length > 0 && <span className="badge">{state.instances.length}</span>}
            {state.status?.executing && (
              <span className="badge badge-in-progress" title="Orchestrator check in progress">
                <span className="in-progress-dot" /> Checking…
              </span>
            )}
            {!state.status?.executing && state.status?.lastTickAt && (
              <span
                className="faint"
                style={{ fontSize: '12px', marginLeft: '6px' }}
                title={`Last checked at ${state.status.lastTickAt}`}
              >
                Checked {formatEventTime(state.status.lastTickAt)}
              </span>
            )}
          </div>
          <div className="panel-actions">
            {state.instances.length > 0 && !isFormVisible && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => {
                  setDraft(defaults);
                  setShowForm(true);
                }}
              >
                + New orchestrator
              </button>
            )}
            <button
              className="btn btn-sm"
              disabled={busy || Boolean(state.status?.executing) || !hasRunning}
              title={
                !hasRunning
                  ? 'Start an orchestrator to check for tasks'
                  : 'Check every running orchestrator now'
              }
              onClick={() => void perform(() => api.tickOrchestrators())}
            >
              {busy || state.status?.executing ? 'Checking…' : 'Check all now'}
            </button>
          </div>
        </div>

        {!loaded ? (
          <p className="faint">Loading…</p>
        ) : !state.instances.length ? (
          <p className="faint">Create an orchestrator to look after your projects' boards.</p>
        ) : (
          <div className="orchestrator-workspace">
            <nav className="orchestrator-picker" aria-label="Choose orchestrator">
              {state.instances.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-pressed={selectedInstance?.id === item.id}
                  onClick={() => {
                    setSearch({ orchestrator: item.id });
                    setPreview(null);
                    setActionResult(null);
                    setHistoryLimit(25);
                  }}
                >
                  <strong>{item.name}</strong>
                  <span>
                    {item.enabled
                      ? item.strategy === 'observe'
                        ? 'Watching'
                        : 'Running'
                      : 'Paused'}{' '}
                    ?{' '}
                    {item.projectIds.length ? `${item.projectIds.length} projects` : 'All projects'}
                  </span>
                </button>
              ))}
            </nav>
            <div className="orchestrator-instances-list">
              {state.instances
                .filter((item) => item.id === selectedInstance?.id)
                .map((instance) => {
                  const scopedProjects = instance.projectIds.length
                    ? projects.filter((p) => instance.projectIds.includes(p.id))
                    : projects;
                  const scopedProjectIds = new Set(scopedProjects.map((p) => p.id));

                  const scopeNames = instance.projectIds.length
                    ? instance.projectIds
                        .map((id) => projects.find((p) => p.id === id)?.name ?? `Project ${id}`)
                        .join(', ')
                    : 'All projects';
                  const providerNames = instance.providers
                    .map((id) => PROVIDER_LABELS[id] ?? id)
                    .join(', ');

                  const todoCount = scopedProjects.reduce(
                    (acc, p) => acc + (p.cardCounts?.todo ?? 0),
                    0,
                  );
                  const inProgressCount = scopedProjects.reduce(
                    (acc, p) => acc + (p.cardCounts?.in_progress ?? 0),
                    0,
                  );
                  const reviewCount = scopedProjects.reduce(
                    (acc, p) => acc + (p.cardCounts?.review ?? 0),
                    0,
                  );
                  const doneCount = scopedProjects.reduce(
                    (acc, p) => acc + (p.cardCounts?.done ?? 0),
                    0,
                  );
                  const totalCards = todoCount + inProgressCount + reviewCount + doneCount;
                  const donePercent =
                    totalCards > 0 ? Math.round((doneCount / totalCards) * 100) : 0;

                  const activeRuns = runs.filter(
                    (r) =>
                      scopedProjectIds.has(r.projectId) &&
                      (r.status === 'running' || r.status === 'queued'),
                  );
                  const activeSessions = sessions.filter(
                    (s) =>
                      scopedProjectIds.has(s.projectId) &&
                      s.status === 'running' &&
                      !s.orchestratorId,
                  );
                  const chatSession =
                    sessions
                      .filter((s) => s.orchestratorId === instance.id)
                      .sort((a, b) => b.id - a.id)[0] ?? null;
                  const collapsed = isCollapsed(instance.id);
                  const section = (key: string) => ({
                    collapsed: isCollapsed(`${instance.id}:${key}`),
                    toggle: () => toggle(`${instance.id}:${key}`),
                  });
                  const progressSection = section('progress');
                  const attentionSection = section('attention');
                  const workSection = section('work');
                  const scopedInFlightCards = inFlightCards.filter((c) =>
                    scopedProjectIds.has(c.projectId),
                  );
                  const liveWorkersCount = activeRuns.length + activeSessions.length;
                  const totalBeingWorkedOnCount = liveWorkersCount + scopedInFlightCards.length;

                  const scopedProjectAttention = scopedProjects.flatMap((p) =>
                    projectAttention(p).map((item) => ({ project: p, ...item })),
                  );
                  const reviewRunsInScope = runs.filter(
                    (r) =>
                      scopedProjectIds.has(r.projectId) &&
                      (r.status === 'failed' || r.status === 'succeeded') &&
                      !r.validation,
                  );
                  const totalAttentionCount =
                    scopedProjectAttention.length + reviewRunsInScope.length;

                  const beingWorkedOnAttentionCount = scopedProjectAttention.filter(
                    ({ project: p }) => {
                      return (
                        activeRuns.some((r) => r.projectId === p.id) ||
                        activeSessions.some((s) => s.projectId === p.id) ||
                        scopedInFlightCards.some(
                          (c) =>
                            c.projectId === p.id && c.title.toLowerCase().includes('attention'),
                        )
                      );
                    },
                  ).length;

                  return (
                    <article
                      className="orchestrator-instance"
                      key={instance.id}
                      data-collapsed={collapsed || undefined}
                    >
                      <div className="orchestrator-instance-head">
                        <div className="orchestrator-instance-title">
                          <button
                            {...collapseButtonProps(instance.name, collapsed, () =>
                              toggle(instance.id),
                            )}
                          />
                          <span
                            className={`orchestrator-status-dot ${instance.enabled ? 'active' : ''}`}
                            title={instance.enabled ? 'Running' : 'Paused'}
                          />
                          <h3>{instance.name}</h3>
                          <span className={instance.enabled ? 'badge badge-done' : 'badge'}>
                            {!instance.enabled
                              ? 'Paused'
                              : instance.strategy === 'observe'
                                ? 'Watching'
                                : 'Running'}
                          </span>
                        </div>
                        <div className="orchestrator-actions">
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy}
                            onClick={() =>
                              void perform(() =>
                                api.saveOrchestrator({ ...instance, enabled: !instance.enabled }),
                              )
                            }
                          >
                            {instance.enabled ? 'Pause' : 'Start'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy || Boolean(state.status?.executing) || !instance.enabled}
                            title={
                              instance.enabled
                                ? "Check this orchestrator's boards now"
                                : 'Start it to check'
                            }
                            onClick={() => void perform(() => api.tickOrchestrators(instance.id))}
                          >
                            {busy || state.status?.executing ? 'Checking…' : 'Check now'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy}
                            onClick={() => {
                              setDraft(instance);
                              setShowForm(true);
                            }}
                          >
                            Edit
                          </button>
                          <ConfirmDelete
                            label={`Delete ${instance.name}`}
                            text="Delete"
                            heading={`Delete orchestrator "${instance.name}"?`}
                            message="This removes the orchestrator and its settings. Workers it started keep running until they finish."
                            confirmLabel="Delete orchestrator"
                            onConfirm={() =>
                              perform(async () => {
                                await api.deleteOrchestrator(instance.id);
                                if (draft.id === instance.id) {
                                  setDraft(defaults);
                                  setShowForm(false);
                                }
                              })
                            }
                          />
                        </div>
                      </div>
                      <p className="orchestrator-instance-about">
                        Looks after <strong>{scopeNames}</strong> · works with {providerNames} · up
                        to {instance.maxWorkers} workers ({instance.maxWorkersPerProject} per
                        project, {instance.maxWorkersPerProvider} per provider) · keeps{' '}
                        {instance.reservePercent}% quota in reserve
                      </p>
                      <div className="orchestrator-pills">
                        <span className="orchestrator-pill">
                          {instance.strategy === 'observe'
                            ? 'Watch only: suggests, never starts workers'
                            : 'Starts workers on its own'}
                        </span>
                        {instance.followDashboardAttention && (
                          <span
                            className="orchestrator-pill orchestrator-pill-accent"
                            title="Turns Dashboard issues (uncommitted, unpushed, stale…) into follow-up tasks"
                          >
                            Follows up Dashboard issues
                          </span>
                        )}
                        {instance.pruneDashboardAttention && (
                          <span
                            className="orchestrator-pill"
                            title="Removes follow-up tasks once their issue is resolved"
                          >
                            Cleans up resolved issues
                          </span>
                        )}
                        {instance.allowUnknownQuota && (
                          <span
                            className="orchestrator-pill orchestrator-pill-warning"
                            title="Starts workers even when a provider's remaining quota is unknown"
                          >
                            ⚠ Unknown quota allowed
                          </span>
                        )}
                      </div>

                      {collapsed && (
                        <p className="orchestrator-instance-summary">
                          {todoCount} to do · {inProgressCount} in progress · {reviewCount} review ·{' '}
                          {totalAttentionCount} need you · {liveWorkersCount} live worker
                          {liveWorkersCount === 1 ? '' : 's'}
                        </p>
                      )}
                      <OrchestratorChat
                        instance={instance}
                        session={chatSession}
                        disabled={busy}
                        onChanged={() => void perform(async () => undefined)}
                      />

                      <details
                        className="orchestrator-owned-runs"
                        id={`orchestrator-runs-${instance.id}`}
                        open={Boolean(
                          search.get('run') &&
                          runs.some(
                            (run) =>
                              run.orchestratorId === instance.id &&
                              String(run.id) === search.get('run'),
                          ),
                        )}
                      >
                        <summary>
                          Dispatched runs (
                          {runs.filter((run) => run.orchestratorId === instance.id).length} shown)
                        </summary>
                        {runs
                          .filter((run) => run.orchestratorId === instance.id)
                          .map((run) => (
                            <RunCard
                              key={run.id}
                              run={run}
                              now={Date.now()}
                              onChanged={() => void perform(async () => undefined)}
                              onDeleted={() => void perform(async () => undefined)}
                            />
                          ))}
                        {runFeed.error && (
                          <p role="alert" className="error-banner">
                            {runFeed.error}
                          </p>
                        )}
                        <nav className="orchestrator-result-links" aria-label="Run history pages">
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={runFeed.loading || !runFeed.previous}
                            onClick={runFeed.previous}
                          >
                            Previous
                          </button>
                          <span>History page {runFeed.page}</span>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={runFeed.loading || !runFeed.next}
                            onClick={runFeed.next}
                          >
                            Next
                          </button>
                        </nav>
                        {!runFeed.loading &&
                          !runs.some((run) => run.orchestratorId === instance.id) && (
                            <p className="faint">
                              Runs started by this orchestrator appear here, with output and review
                              controls.
                            </p>
                          )}
                      </details>

                      {/* Needs you: issues and failures in scope */}
                      <div
                        className="orchestrator-scope-section orchestrator-attention-section"
                        data-collapsed={attentionSection.collapsed || undefined}
                      >
                        <div className="orchestrator-scope-section-head">
                          <div className="orchestrator-section-title-group">
                            <button
                              {...collapseButtonProps(
                                'Needs you',
                                attentionSection.collapsed,
                                attentionSection.toggle,
                              )}
                            />
                            <span
                              className={`orchestrator-pulse-dot ${totalAttentionCount > 0 ? 'warning' : 'clean'}`}
                              aria-hidden="true"
                            />
                            <span className="orchestrator-subheading">Needs you</span>
                            <span
                              className={
                                totalAttentionCount > 0 ? 'badge badge-danger' : 'badge badge-done'
                              }
                            >
                              {totalAttentionCount > 0
                                ? `${totalAttentionCount} issue${totalAttentionCount === 1 ? '' : 's'}`
                                : 'Clean'}
                            </span>
                            {beingWorkedOnAttentionCount > 0 && (
                              <span
                                className="badge badge-in-progress"
                                title="Items with active workers resolving them"
                              >
                                {`${beingWorkedOnAttentionCount} being worked on`}
                              </span>
                            )}
                          </div>
                          <div className="orchestrator-section-actions">
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              disabled={busy || totalAttentionCount === 0}
                              title="Create follow-up tasks for these issues and let this orchestrator start workers on them (within its limits)"
                              onClick={() => void resolvePending(instance)}
                            >
                              Fix all
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busy || totalAttentionCount === 0}
                              title="Remove follow-up tasks whose issue is already resolved"
                              onClick={() =>
                                void perform(() => api.pruneOrchestratorAttention(instance.id))
                              }
                            >
                              Clear resolved
                            </button>
                          </div>
                        </div>
                        {totalAttentionCount === 0 ? (
                          <p className="faint orchestrator-attention-clean">
                            ✓ Nothing needs you right now.
                          </p>
                        ) : (
                          <div className="orchestrator-attention-grid">
                            {scopedProjectAttention.map(({ project: p, kind, detail }) => {
                              const runningRun = activeRuns.find((r) => r.projectId === p.id);
                              const runningSession = activeSessions.find(
                                (s) => s.projectId === p.id,
                              );
                              const inFlightAttentionCard = scopedInFlightCards.find(
                                (c) =>
                                  c.projectId === p.id &&
                                  c.title.toLowerCase().includes('attention'),
                              );
                              const isWorkedOn = Boolean(
                                runningRun || runningSession || inFlightAttentionCard,
                              );

                              return (
                                <div
                                  key={`att-${p.id}-${kind}`}
                                  className="orchestrator-attention-item"
                                >
                                  <span
                                    className={`badge${kind === 'Folder missing' || kind === 'Scan failed' ? ' badge-danger' : ' badge-attention'}`}
                                  >
                                    {kind}
                                  </span>
                                  <div className="attention-item-info">
                                    <Link
                                      to={`/projects/${p.id}`}
                                      className="attention-proj truncate"
                                    >
                                      {p.name}
                                    </Link>
                                    <span
                                      className="attention-detail faint truncate"
                                      title={detail}
                                    >
                                      {detail}
                                    </span>
                                  </div>
                                  <div className="attention-item-actions">
                                    {isWorkedOn ? (
                                      <>
                                        <span
                                          className="badge badge-in-progress"
                                          title="Currently being worked on"
                                        >
                                          <span
                                            className="orchestrator-pulse-dot pulse in-progress-dot"
                                            aria-hidden="true"
                                          />
                                          Being worked on
                                        </span>
                                        {runningRun && (
                                          <Link
                                            to={
                                              runningRun.orchestratorId
                                                ? `/orchestrators?orchestrator=${runningRun.orchestratorId}&run=${runningRun.id}#orchestrator-runs-${runningRun.orchestratorId}`
                                                : '/workspace'
                                            }
                                            className="worker-action-link"
                                            title="Open terminal"
                                          >
                                            Terminal →
                                          </Link>
                                        )}
                                        {runningSession && !runningRun && (
                                          <Link
                                            to={`/workspace?open=${runningSession.id}`}
                                            className="worker-action-link"
                                            title="Open session"
                                          >
                                            Session →
                                          </Link>
                                        )}
                                      </>
                                    ) : (
                                      <>
                                        <button
                                          type="button"
                                          className="btn btn-xs btn-primary attention-resolve-btn"
                                          disabled={busy}
                                          title="Create a follow-up task and let this orchestrator start a worker on it (within its limits)"
                                          onClick={() => void resolvePending(instance, p.id)}
                                        >
                                          Fix
                                        </button>
                                        <button
                                          type="button"
                                          className="btn btn-xs link-button faint"
                                          disabled={busy}
                                          title="Hide this issue without running an agent"
                                          onClick={() =>
                                            void perform(async () => {
                                              await api.dismissOrchestratorAttention(p.id, [kind]);
                                              await api.pruneOrchestratorAttention(
                                                instance.id,
                                                p.id,
                                              );
                                            })
                                          }
                                        >
                                          Dismiss
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                            {reviewRunsInScope.map((run) => {
                              const proj = projects.find((p) => p.id === run.projectId);
                              return (
                                <div key={`fail-${run.id}`} className="orchestrator-attention-item">
                                  <span
                                    className={
                                      run.status === 'failed'
                                        ? 'badge badge-danger'
                                        : 'badge badge-attention'
                                    }
                                  >
                                    {run.status === 'failed' ? 'Failed run' : 'Needs review'}
                                  </span>
                                  <div className="attention-item-info">
                                    <span className="attention-proj truncate">
                                      {proj?.name ?? `Project ${run.projectId}`}
                                    </span>
                                    <span
                                      className="attention-detail faint truncate"
                                      title={run.error ?? run.name}
                                    >
                                      {run.name}:{' '}
                                      {run.error ??
                                        (run.status === 'failed'
                                          ? 'Execution failed'
                                          : 'Finished; review before accepting')}
                                    </span>
                                  </div>
                                  <div className="attention-item-actions">
                                    {run.status === 'failed' && (
                                      <button
                                        type="button"
                                        className="btn btn-xs btn-primary attention-resolve-btn"
                                        disabled={busy}
                                        title="Retry failed run"
                                        onClick={() => void perform(() => api.retryRun(run.id))}
                                      >
                                        Retry
                                      </button>
                                    )}
                                    <Link
                                      to={
                                        run.orchestratorId
                                          ? `/orchestrators?orchestrator=${run.orchestratorId}&run=${run.id}#orchestrator-runs-${run.orchestratorId}`
                                          : `/projects/${run.projectId}?tab=agents`
                                      }
                                      className="worker-action-link"
                                      title="Inspect run and review its result"
                                    >
                                      Review →
                                    </Link>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        <OrchestratorPending
                          runOwners={
                            new Map(
                              runs
                                .filter((run) => run.orchestratorId)
                                .map((run) => [run.id, run.orchestratorId!]),
                            )
                          }
                          masterId={instance.id}
                          busy={busy}
                          canRun={instance.enabled && instance.strategy !== 'observe'}
                          onFollowUp={(id) => void resolvePending(instance, id)}
                        />
                      </div>

                      {/* Board progress in scope */}
                      <div
                        className="orchestrator-scope-section"
                        data-collapsed={progressSection.collapsed || undefined}
                      >
                        <div className="orchestrator-scope-section-head">
                          <div className="orchestrator-section-title-group">
                            <button
                              {...collapseButtonProps(
                                'Board',
                                progressSection.collapsed,
                                progressSection.toggle,
                              )}
                            />
                            <span className="orchestrator-subheading">Board</span>
                          </div>
                          <div className="orchestrator-section-actions">
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busy}
                              onClick={() =>
                                void perform(async () =>
                                  setPreview({
                                    id: instance.id,
                                    data: await api.previewOrchestrator(instance.id),
                                  }),
                                )
                              }
                            >
                              Preview plan
                            </button>
                            <Link
                              to={
                                instance.projectIds.length === 1
                                  ? `/board?project=${instance.projectIds[0]}`
                                  : '/board'
                              }
                              className="orchestrator-section-link"
                            >
                              View board →
                            </Link>
                          </div>
                        </div>
                        <div className="orchestrator-scope-stats">
                          <div className="orchestrator-scope-stat">
                            <span className="stat-label">To do</span>
                            <span className="stat-num num">{todoCount}</span>
                          </div>
                          <div className="orchestrator-scope-stat">
                            <span className="stat-label">In progress</span>
                            <span className="stat-num num">{inProgressCount}</span>
                          </div>
                          <div className="orchestrator-scope-stat">
                            <span className="stat-label">Review</span>
                            <span className="stat-num num">{reviewCount}</span>
                          </div>
                          <div className="orchestrator-scope-stat">
                            <span className="stat-label">Done</span>
                            <span className="stat-num num">{doneCount}</span>
                          </div>
                        </div>
                        {totalCards > 0 && (
                          <div
                            className="orchestrator-progress-bar"
                            role="progressbar"
                            aria-valuenow={donePercent}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            title={`${donePercent}% completed (${doneCount}/${totalCards} cards)`}
                          >
                            {doneCount > 0 && (
                              <div
                                className="orchestrator-progress-seg seg-done"
                                style={{ width: `${(doneCount / totalCards) * 100}%` }}
                                title={`Done: ${doneCount}`}
                              />
                            )}
                            {reviewCount > 0 && (
                              <div
                                className="orchestrator-progress-seg seg-review"
                                style={{ width: `${(reviewCount / totalCards) * 100}%` }}
                                title={`Review: ${reviewCount}`}
                              />
                            )}
                            {inProgressCount > 0 && (
                              <div
                                className="orchestrator-progress-seg seg-in-progress"
                                style={{ width: `${(inProgressCount / totalCards) * 100}%` }}
                                title={`In progress: ${inProgressCount}`}
                              />
                            )}
                            {todoCount > 0 && (
                              <div
                                className="orchestrator-progress-seg seg-todo"
                                style={{ width: `${(todoCount / totalCards) * 100}%` }}
                                title={`To do: ${todoCount}`}
                              />
                            )}
                          </div>
                        )}
                      </div>

                      {preview?.id === instance.id && (
                        <section className="orchestrator-plan-preview" aria-label="Plan preview">
                          <div className="orchestrator-plan-preview-head">
                            <div className="orchestrator-plan-preview-title">
                              <h4>Plan preview</h4>
                              <span className="badge">
                                Snapshot {formatEventTime(preview.data.at)}
                              </span>
                            </div>
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => setPreview(null)}
                            >
                              Close preview
                            </button>
                          </div>
                          <p className="orchestrator-plan-preview-desc">
                            No work was started.{' '}
                            {instance.strategy === 'observe'
                              ? 'Observe reports these proposals only.'
                              : !instance.enabled
                                ? 'Paused; start to allow dispatch.'
                                : 'Actual dispatch rechecks quota and capacity before assigning work.'}
                          </p>
                          {preview.data.summary && (
                            <p className="faint">
                              {preview.data.total} tasks: {preview.data.summary.dispatch} ready,{' '}
                              {preview.data.summary.review} review, {preview.data.summary.wait}{' '}
                              waiting. Showing{' '}
                              {preview.data.decisions.length ? (preview.data.offset ?? 0) + 1 : 0}-
                              {(preview.data.offset ?? 0) + preview.data.decisions.length}.
                            </p>
                          )}
                          {!preview.data.decisions.length ? (
                            <p className="orchestrator-preview-empty">No board tasks in scope.</p>
                          ) : (
                            <ul className="orchestrator-plan-decisions-list">
                              {preview.data.decisions.map((d) => (
                                <li key={d.cardId} className="orchestrator-plan-decision-item">
                                  <span
                                    className={
                                      d.action === 'dispatch'
                                        ? 'badge badge-done'
                                        : d.action === 'review'
                                          ? 'badge badge-attention'
                                          : 'badge'
                                    }
                                  >
                                    {d.action === 'dispatch'
                                      ? 'Will dispatch'
                                      : d.action === 'review'
                                        ? 'Review'
                                        : d.waitReason
                                          ? (WAIT_REASON_LABELS[d.waitReason] ?? 'Wait')
                                          : 'Wait'}
                                  </span>
                                  <Link
                                    to={`/board?project=${d.projectId}&card=${d.cardId}`}
                                    className="event-card-link"
                                    title={`Open card PM-${d.cardId}`}
                                  >
                                    PM-{d.cardId}
                                  </Link>
                                  {d.providerId && (
                                    <span className="badge">
                                      {PROVIDER_LABELS[d.providerId] ?? d.providerId}
                                    </span>
                                  )}
                                  <span className="plan-decision-reason">{d.reason}</span>
                                  <OrchestratorNextStep decision={d} />
                                  {d.providerBlockers?.length ? (
                                    <ul>
                                      {d.providerBlockers.map((blocker) => (
                                        <li key={blocker.providerId}>
                                          {PROVIDER_LABELS[blocker.providerId] ??
                                            blocker.providerId}
                                          : {blocker.detail}
                                        </li>
                                      ))}
                                    </ul>
                                  ) : null}
                                  {d.occupancy && d.occupancy.externalWorkers > 0 && (
                                    <span
                                      className="faint"
                                      style={{ fontSize: '11px', flex: 'none' }}
                                    >
                                      Managed: {d.occupancy.managedWorkers} · External:{' '}
                                      {d.occupancy.externalWorkers}
                                    </span>
                                  )}
                                  {d.retry && (
                                    <span
                                      className="faint"
                                      style={{ fontSize: '11px', flex: 'none' }}
                                    >
                                      {d.retry.attemptsUsed}/3 used
                                      {d.retry.blocker ? ` · ${d.retry.blocker}` : ''}
                                      {d.retry.retryAt
                                        ? ` (cooldown until ${formatEventTime(d.retry.retryAt)})`
                                        : ''}
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                          {(preview.data.total ?? 0) > (preview.data.limit ?? 100) && (
                            <div className="orchestrator-result-links">
                              <button
                                type="button"
                                className="btn btn-sm"
                                disabled={busy || !preview.data.offset}
                                onClick={() =>
                                  void perform(async () =>
                                    setPreview({
                                      id: instance.id,
                                      data: await api.previewOrchestrator(
                                        instance.id,
                                        Math.max(
                                          0,
                                          (preview.data.offset ?? 0) - (preview.data.limit ?? 100),
                                        ),
                                      ),
                                    }),
                                  )
                                }
                              >
                                Previous tasks
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm"
                                disabled={
                                  busy ||
                                  (preview.data.offset ?? 0) + preview.data.decisions.length >=
                                    (preview.data.total ?? 0)
                                }
                                onClick={() =>
                                  void perform(async () =>
                                    setPreview({
                                      id: instance.id,
                                      data: await api.previewOrchestrator(
                                        instance.id,
                                        (preview.data.offset ?? 0) + (preview.data.limit ?? 100),
                                      ),
                                    }),
                                  )
                                }
                              >
                                Next tasks
                              </button>
                            </div>
                          )}
                        </section>
                      )}

                      {/* Being worked on in scope */}
                      <div
                        className="orchestrator-scope-section"
                        data-collapsed={workSection.collapsed || undefined}
                      >
                        <div className="orchestrator-scope-section-head">
                          <div className="orchestrator-section-title-group">
                            <button
                              {...collapseButtonProps(
                                'Working now',
                                workSection.collapsed,
                                workSection.toggle,
                              )}
                            />
                            <span
                              className={`orchestrator-pulse-dot ${totalBeingWorkedOnCount > 0 ? 'pulse' : ''}`}
                              aria-hidden="true"
                            />
                            <span className="orchestrator-subheading">Working now</span>
                            <span
                              className={totalBeingWorkedOnCount > 0 ? 'badge badge-done' : 'badge'}
                            >
                              {`${totalBeingWorkedOnCount} active`}
                            </span>
                          </div>
                          <Link to="/workspace" className="orchestrator-section-link">
                            All terminals →
                          </Link>
                        </div>
                        {totalBeingWorkedOnCount === 0 ? (
                          <p className="faint orchestrator-workers-empty">
                            Nothing is being worked on right now.
                          </p>
                        ) : (
                          <div className="orchestrator-workers-grid">
                            {activeRuns.map((run) => {
                              const proj = projects.find((p) => p.id === run.projectId);
                              return (
                                <div key={`run-${run.id}`} className="orchestrator-worker-card">
                                  <div className="worker-card-head">
                                    <span
                                      className={`worker-dot ${run.status === 'running' ? 'running' : 'queued'}`}
                                      title={run.status === 'running' ? 'Running' : 'Queued'}
                                    />
                                    <span
                                      className="worker-name truncate"
                                      title={run.name || `Run #${run.id}`}
                                    >
                                      {run.name || `Run #${run.id}`}
                                    </span>
                                    <span className="badge">
                                      {PROVIDER_LABELS[run.providerId] ?? run.providerId}
                                    </span>
                                  </div>
                                  <div className="worker-card-meta">
                                    {proj && (
                                      <span className="worker-proj truncate">{proj.name}</span>
                                    )}
                                    {run.cardId && (
                                      <Link
                                        to={`/board?project=${run.projectId}&card=${run.cardId}`}
                                        className="event-card-link"
                                        title={`View card PM-${run.cardId}`}
                                      >
                                        {`PM-${run.cardId}`}
                                      </Link>
                                    )}
                                    <Link
                                      to="/workspace"
                                      className="worker-action-link"
                                      title="Open workspace"
                                    >
                                      Workspace →
                                    </Link>
                                  </div>
                                </div>
                              );
                            })}
                            {activeSessions.map((session) => {
                              const proj = projects.find((p) => p.id === session.projectId);
                              return (
                                <div
                                  key={`session-${session.id}`}
                                  className="orchestrator-worker-card"
                                >
                                  <div className="worker-card-head">
                                    <span className="worker-dot running" title="Running" />
                                    <span
                                      className="worker-name truncate"
                                      title={session.name || `Session #${session.id}`}
                                    >
                                      {session.name || `Session #${session.id}`}
                                    </span>
                                    <span className="badge">
                                      {PROVIDER_LABELS[session.providerId] ?? session.providerId}
                                    </span>
                                  </div>
                                  <div className="worker-card-meta">
                                    {proj && (
                                      <span className="worker-proj truncate">{proj.name}</span>
                                    )}
                                    {session.cardId && (
                                      <Link
                                        to={`/board?project=${session.projectId}&card=${session.cardId}`}
                                        className="event-card-link"
                                        title={`View card PM-${session.cardId}`}
                                      >
                                        {`PM-${session.cardId}`}
                                      </Link>
                                    )}
                                    <Link
                                      to={`/workspace?open=${session.id}`}
                                      className="worker-action-link"
                                      title="Open terminal in workspace"
                                    >
                                      Terminal →
                                    </Link>
                                  </div>
                                </div>
                              );
                            })}
                            {scopedInFlightCards
                              .filter(
                                (c) =>
                                  !activeRuns.some((r) => r.cardId === c.id) &&
                                  !activeSessions.some((s) => s.cardId === c.id),
                              )
                              .map((card) => (
                                <div key={`card-${card.id}`} className="orchestrator-worker-card">
                                  <div className="worker-card-head">
                                    <span
                                      className="worker-dot queued"
                                      title={
                                        card.status === 'in_progress' ? 'In progress' : 'Review'
                                      }
                                    />
                                    <span className="worker-name truncate" title={card.title}>
                                      {card.title}
                                    </span>
                                    <span className="badge">
                                      {card.status === 'in_progress' ? 'In progress' : 'Review'}
                                    </span>
                                  </div>
                                  <div className="worker-card-meta">
                                    <span className="worker-proj truncate">{card.projectName}</span>
                                    <Link
                                      to={`/board?project=${card.projectId}&card=${card.id}`}
                                      className="event-card-link"
                                      title={`View card ${card.key}`}
                                    >
                                      {card.key}
                                    </Link>
                                    <Link
                                      to={`/board?project=${card.projectId}&card=${card.id}`}
                                      className="worker-action-link"
                                      title="Open board"
                                    >
                                      Board →
                                    </Link>
                                  </div>
                                </div>
                              ))}
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
            </div>
          </div>
        )}
      </section>

      {/* Configuration: a modal dialog over the page when orchestrators exist (PM-73); inline as
          the page's first-run content when there are none yet. */}
      {isFormVisible && (
        <OrchestratorFormShell
          modal={state.instances.length > 0}
          title={draft.id ? 'Edit orchestrator' : 'New orchestrator'}
          onClose={() => {
            setDraft(defaults);
            setShowForm(false);
          }}
        >
          <section className="panel orchestrator-form-panel">
            <div className="panel-header">
              <div>
                <h2>{draft.id ? 'Edit orchestrator' : 'New orchestrator'}</h2>
                <p className="faint" style={{ margin: '4px 0 0' }}>
                  {draft.id
                    ? `Updating configuration for "${draft.name}"`
                    : 'Choose the projects it looks after, which agents it may start and how many at once.'}
                </p>
              </div>
              {state.instances.length > 0 && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setDraft(defaults);
                    setShowForm(false);
                  }}
                >
                  Cancel edit
                </button>
              )}
            </div>
            <form
              className="orchestrator-form"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(async () => {
                  await api.saveOrchestrator(draft);
                  setDraft(defaults);
                  setShowForm(false);
                });
              }}
            >
              <div className="orchestrator-form-section">
                <h3 className="orchestrator-form-section-title">What it looks after</h3>
                <div className="orchestrator-form-grid">
                  <label>
                    Name
                    <input
                      className="input"
                      required
                      maxLength={120}
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                  </label>
                  <label>
                    Project scope
                    <Dropdown
                      label="Project scope"
                      value={0}
                      onChange={() => {}}
                      multiple={{
                        values: draft.projectIds,
                        allValue: 0,
                        onChange: (projectIds) => setDraft({ ...draft, projectIds }),
                      }}
                      options={[
                        { value: 0, label: 'All projects' },
                        ...projects.map((p) => ({ value: p.id, label: p.name })),
                      ]}
                    />
                  </label>
                </div>
              </div>

              <div className="orchestrator-form-section">
                <h3 className="orchestrator-form-section-title">Workers it may start</h3>
                <div className="orchestrator-form-grid">
                  <label>
                    Worker providers
                    <Dropdown
                      label="Worker providers"
                      value="all"
                      onChange={() => {}}
                      multiple={{
                        values: draft.providers,
                        allValue: 'all',
                        onChange: (providers) =>
                          setDraft({
                            ...draft,
                            providers: providers.length ? providers : ['codex'],
                          }),
                      }}
                      options={[
                        { value: 'all', label: 'Reset to Codex' },
                        ...['codex', 'claude', 'antigravity', 'grok', 'opencode'].map((id) => ({
                          value: id,
                          label: PROVIDER_LABELS[id] ?? id,
                        })),
                      ]}
                    />
                  </label>
                  <label>
                    Total worker limit
                    <input
                      className="input"
                      type="number"
                      required
                      min={1}
                      max={32}
                      value={draft.maxWorkers}
                      onChange={(e) => setDraft({ ...draft, maxWorkers: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    Workers per project
                    <input
                      className="input"
                      type="number"
                      required
                      min={1}
                      max={8}
                      value={draft.maxWorkersPerProject}
                      onChange={(e) =>
                        setDraft({ ...draft, maxWorkersPerProject: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    Workers per provider
                    <input
                      className="input"
                      type="number"
                      required
                      min={1}
                      max={16}
                      value={draft.maxWorkersPerProvider}
                      onChange={(e) =>
                        setDraft({ ...draft, maxWorkersPerProvider: Number(e.target.value) })
                      }
                    />
                  </label>
                </div>
              </div>

              <div className="orchestrator-form-section">
                <h3 className="orchestrator-form-section-title">How it works</h3>
                <label>
                  Strategy
                  <Dropdown
                    label="Strategy"
                    value={draft.strategy ?? 'autonomous'}
                    options={[
                      {
                        value: 'observe' as const,
                        label: 'Watch only',
                        sub: 'Shows what is ready and suggests next steps; never starts workers',
                      },
                      {
                        value: 'autonomous' as const,
                        label: 'Start workers on its own',
                        sub: 'Starts ready tasks within your limits and quota; finished work waits for your review',
                      },
                    ]}
                    onChange={(strategy) => setDraft({ ...draft, strategy })}
                  />
                </label>
                <div className="orchestrator-form-grid">
                  <label>
                    Quota reserve (%)
                    <input
                      className="input"
                      type="number"
                      required
                      min={0}
                      max={90}
                      value={draft.reservePercent}
                      onChange={(e) =>
                        setDraft({ ...draft, reservePercent: Number(e.target.value) })
                      }
                    />
                  </label>
                </div>
                <div className="orchestrator-checkboxes">
                  <label className="orchestrator-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.allowUnknownQuota}
                      onChange={(e) => setDraft({ ...draft, allowUnknownQuota: e.target.checked })}
                    />
                    Allow workers when quota is unknown
                  </label>
                  <label className="orchestrator-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.followDashboardAttention ?? false}
                      onChange={(e) =>
                        setDraft({ ...draft, followDashboardAttention: e.target.checked })
                      }
                    />
                    Follow up Dashboard issues (uncommitted, unpushed, stale…)
                  </label>
                  <label className="orchestrator-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.pruneDashboardAttention ?? true}
                      onChange={(e) =>
                        setDraft({ ...draft, pruneDashboardAttention: e.target.checked })
                      }
                    />
                    Remove follow-up tasks once their issue is resolved
                  </label>
                </div>
              </div>

              <p className="faint">
                Saved paused by default. Start authorizes board tasks to run with your agent
                permission settings. Completed work stays available for review.
              </p>
              <div className="orchestrator-actions">
                <button className="btn btn-primary" disabled={busy}>
                  Save{draft.enabled ? ' active orchestrator' : ' orchestrator'}
                </button>
                {state.instances.length > 0 && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setDraft(defaults);
                      setShowForm(false);
                    }}
                  >
                    Cancel edit
                  </button>
                )}
              </div>
            </form>
          </section>
        </OrchestratorFormShell>
      )}
      <section
        className="panel orchestrator-history-panel"
        data-collapsed={isCollapsed('history') || undefined}
      >
        <div className="orchestrator-history-header">
          <div className="orchestrator-history-title">
            <button
              {...collapseButtonProps('Activity', isCollapsed('history'), () => toggle('history'))}
            />
            <h2>Activity</h2>
            {allCount > 0 && <span className="badge">{allCount}</span>}
          </div>
          {allCount > 0 && (
            <button
              type="button"
              className="link-button faint"
              disabled={busy}
              onClick={() => void perform(() => api.clearOrchestratorEvents())}
            >
              Clear activity
            </button>
          )}
        </div>

        {!allCount ? (
          <p className="faint">What your orchestrators do shows up here.</p>
        ) : (
          <>
            <div className="orchestrator-history-filters" role="group" aria-label="Filter activity">
              <button
                type="button"
                className={`work-chip${historyFilter === 'all' ? ' active' : ''}`}
                onClick={() => setHistoryFilter('all')}
              >
                All <span className="work-chip-count num">{allCount}</span>
              </button>
              <button
                type="button"
                className={`work-chip${historyFilter === 'dispatched' ? ' active' : ''}`}
                onClick={() => setHistoryFilter('dispatched')}
              >
                Started work <span className="work-chip-count num">{dispatchedCount}</span>
              </button>
              <button
                type="button"
                className={`work-chip${historyFilter === 'wait' ? ' active' : ''}`}
                onClick={() => setHistoryFilter('wait')}
              >
                Waiting <span className="work-chip-count num">{waitCount}</span>
              </button>
              {prunedCount > 0 && (
                <button
                  type="button"
                  className={`work-chip${historyFilter === 'pruned' ? ' active' : ''}`}
                  onClick={() => setHistoryFilter('pruned')}
                >
                  Cleaned up <span className="work-chip-count num">{prunedCount}</span>
                </button>
              )}
              {errorCount > 0 && (
                <button
                  type="button"
                  className={`work-chip${historyFilter === 'error' ? ' active' : ''}`}
                  onClick={() => setHistoryFilter('error')}
                >
                  Errors <span className="work-chip-count num">{errorCount}</span>
                </button>
              )}
            </div>

            {!visibleEvents.length ? (
              <p className="faint">Nothing matches this filter.</p>
            ) : (
              <ul className="orchestrator-events">
                {visibleEvents.map((event, index) => {
                  const owner = state.instances.find((i) => i.id === event.orchestratorId);
                  return (
                    <li key={`${event.at}-${index}`}>
                      <div className="event-meta">
                        <time dateTime={event.at} title={new Date(event.at).toLocaleString()}>
                          {formatEventTime(event.at)}
                        </time>
                        <span className={actionBadgeClass(event.action)}>{event.action}</span>
                        {event.cardId && (
                          <Link
                            to={`/board?card=${event.cardId}`}
                            className="event-card-link"
                            title={`View card PM-${event.cardId}`}
                          >
                            PM-{event.cardId}
                          </Link>
                        )}
                        {Boolean(event.count && event.count > 1) && (
                          <span
                            className="event-count-badge"
                            title={`Repeated ${event.count} times`}
                          >
                            {event.count}×
                          </span>
                        )}
                      </div>
                      <div className="event-body">
                        <span className="event-msg">{event.message}</span>
                        {state.instances.length > 1 && owner && (
                          <span className="event-orchestrator-name faint">({owner.name})</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {reversedEvents.length > historyLimit && (
              <div className="orchestrator-history-footer">
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setHistoryLimit((prev) => prev + 25)}
                >
                  Show older ({reversedEvents.length - historyLimit} more)
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}

/**
 * Hosts the orchestrator form: a modal dialog (Esc / Cancel close it, focus stays inside) when
 * there are orchestrators to return to, the plain inline panel otherwise.
 */
function OrchestratorFormShell({
  modal,
  title,
  onClose,
  children,
}: {
  modal: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (modal && dialog && !dialog.open) dialog.showModal();
  }, [modal]);
  if (!modal) return <>{children}</>;
  return (
    <dialog ref={ref} className="orchestrator-form-dialog" aria-label={title} onClose={onClose}>
      {children}
    </dialog>
  );
}
