import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { Dropdown } from '../components/Dropdown';
import { ConfirmDelete } from '../components/ConfirmDelete';
import { PROVIDER_LABELS } from '../components/icons';
import type {
  AgentRun,
  AgentSession,
  CardWithProject,
  ProjectSummary,
} from '../../../shared/types';
import type { OrchestratorConfig, OrchestratorState } from '../../../shared/orchestrator';
import { projectAttention } from '../../../shared/projectAttention';
import './orchestrator.css';
import { serialPoll } from '../lib/serialPoll';

const defaults: Omit<OrchestratorConfig, 'id'> = {
  name: 'Master orchestrator',
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
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [inFlightCards, setInFlightCards] = useState<CardWithProject[]>([]);
  const [draft, setDraft] = useState<Omit<OrchestratorConfig, 'id'> & { id?: string }>(defaults);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');
  const [quickMasterId, setQuickMasterId] = useState('');
  const [quickProjectId, setQuickProjectId] = useState('');
  const [actionResult, setActionResult] = useState<{
    message: string;
    cards: number[];
    runs: number[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
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
        api.listAllRuns().then(
          (next) => {
            if (current()) setRuns(next);
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
      const [nextState, nextProjects, nextRuns, nextSessions, nextInFlight] = await Promise.all([
        api.orchestrators(),
        api.listProjects().catch(() => projects),
        api.listAllRuns().catch(() => runs),
        api.listAllSessions().catch(() => sessions),
        api.listCardsInFlight().catch(() => inFlightCards),
      ]);
      setState(nextState);
      setProjects(nextProjects);
      setRuns(nextRuns);
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
              ? 'Follow-ups queued. This master is paused; start it when ready to dispatch.'
              : instance.strategy === 'observe'
                ? 'Follow-ups queued. Observe mode does not dispatch; switch to Autonomous board work to run them.'
                : 'Follow-ups queued; no new run started. Preview plan shows worker, quota and review blockers.',
      });
    });
  const quickMaster = state.instances.find((i) => i.id === quickMasterId) ?? state.instances[0];
  const quickProjects = projects.filter(
    (p) => !quickMaster?.projectIds.length || quickMaster.projectIds.includes(p.id),
  );
  const selectedQuickProject = quickProjects.find((p) => String(p.id) === quickProjectId);
  const quickScope = selectedQuickProject ? [selectedQuickProject] : quickProjects;
  const quickIssueCount = quickScope.reduce((sum, p) => sum + projectAttention(p).length, 0);
  const quickCanRun = Boolean(quickMaster?.enabled && quickMaster.strategy !== 'observe');

  const isFormVisible = showForm || Boolean(draft.id) || state.instances.length === 0;
  const hasActiveMasters = state.instances.some((i) => i.enabled);

  const allCount = state.events.length;
  const dispatchedCount = state.events.filter(
    (e) => e.action === 'dispatched' || e.action === 'dispatching',
  ).length;
  const waitCount = state.events.filter((e) => e.action === 'wait' || e.action === 'review').length;
  const prunedCount = state.events.filter((e) => e.action === 'pruned').length;
  const errorCount = state.events.filter((e) => e.action === 'error').length;

  const filteredEvents = state.events.filter((e) => {
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
        <h1>Orchestrators</h1>
        <Link className="btn btn-sm" to="/workspace">
          Agent terminals
        </Link>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      {state.instances.length > 0 && quickMaster && (
        <section className="panel orchestrator-quick-actions" aria-labelledby="quick-runs-heading">
          <h2 id="quick-runs-heading">Quick runs</h2>
          <div className="orchestrator-quick-controls">
            <div className="orchestrator-quick-field">
              <label htmlFor="quick-master">Master</label>
              <Dropdown
                id="quick-master"
                label="Quick run master"
                disabled={busy}
                value={quickMaster.id}
                options={state.instances.map((i) => ({ value: i.id, label: i.name }))}
                onChange={(id) => {
                  setQuickMasterId(id);
                  setQuickProjectId('');
                }}
              />
            </div>
            <div className="orchestrator-quick-field">
              <label htmlFor="quick-project">Project</label>
              <Dropdown
                id="quick-project"
                label="Quick run project"
                disabled={busy}
                value={selectedQuickProject ? String(selectedQuickProject.id) : ''}
                options={[
                  { value: '', label: 'All projects in scope' },
                  ...quickProjects.map((p) => ({ value: String(p.id), label: p.name })),
                ]}
                onChange={setQuickProjectId}
              />
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || quickIssueCount === 0}
              onClick={() => void resolvePending(quickMaster, selectedQuickProject?.id)}
            >
              {busy ? 'Working...' : quickCanRun ? 'Run pending issues' : 'Queue follow-ups'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  setPreview({
                    id: quickMaster.id,
                    data: await api.previewOrchestrator(quickMaster.id),
                  });
                })
              }
            >
              Inspect queue
            </button>
          </div>
          <p className="faint">
            {quickIssueCount} Dashboard issue{quickIssueCount === 1 ? '' : 's'} in scope. Creates or
            reuses follow-up tasks and checks this master's board queue.{' '}
            {quickCanRun
              ? 'Provider, quota and worker limits apply; completed runs await review.'
              : 'Queued tasks stay pending while this master is paused or observing.'}
          </p>
        </section>
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

      {/* Primary Masters dashboard panel */}
      <section className="panel orchestrator-masters-panel">
        <div className="panel-header">
          <div className="panel-title-group">
            <h2>Masters</h2>
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
                + New master
              </button>
            )}
            <button
              className="btn btn-sm"
              disabled={busy || Boolean(state.status?.executing) || !hasActiveMasters}
              title={
                !hasActiveMasters
                  ? 'Enable a master to check for tasks'
                  : 'Run check across all active masters'
              }
              onClick={() => void perform(() => api.tickOrchestrators())}
            >
              {busy || state.status?.executing ? 'Checking…' : 'Check all'}
            </button>
          </div>
        </div>

        {!loaded ? (
          <p className="faint">Loading…</p>
        ) : !state.instances.length ? (
          <p className="faint">Create a master to coordinate board work across your projects.</p>
        ) : (
          <div className="orchestrator-instances-list">
            {state.instances.map((instance) => {
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
              const donePercent = totalCards > 0 ? Math.round((doneCount / totalCards) * 100) : 0;

              const activeRuns = runs.filter(
                (r) =>
                  scopedProjectIds.has(r.projectId) &&
                  (r.status === 'running' || r.status === 'queued'),
              );
              const activeSessions = sessions.filter(
                (s) => scopedProjectIds.has(s.projectId) && s.status === 'running',
              );
              const scopedInFlightCards = inFlightCards.filter((c) =>
                scopedProjectIds.has(c.projectId),
              );
              const liveWorkersCount = activeRuns.length + activeSessions.length;
              const totalBeingWorkedOnCount = liveWorkersCount + scopedInFlightCards.length;

              const scopedProjectAttention = scopedProjects.flatMap((p) =>
                projectAttention(p).map((item) => ({ project: p, ...item })),
              );
              const failedRunsInScope = runs.filter(
                (r) => scopedProjectIds.has(r.projectId) && r.status === 'failed',
              );
              const totalAttentionCount = scopedProjectAttention.length + failedRunsInScope.length;

              const beingWorkedOnAttentionCount = scopedProjectAttention.filter(
                ({ project: p }) => {
                  return (
                    activeRuns.some((r) => r.projectId === p.id) ||
                    activeSessions.some((s) => s.projectId === p.id) ||
                    scopedInFlightCards.some(
                      (c) => c.projectId === p.id && c.title.toLowerCase().includes('attention'),
                    )
                  );
                },
              ).length;

              return (
                <article className="orchestrator-instance" key={instance.id}>
                  <div className="orchestrator-instance-head">
                    <div className="orchestrator-instance-title">
                      <span
                        className={`orchestrator-status-dot ${instance.enabled ? 'active' : ''}`}
                        title={instance.enabled ? 'Master is running' : 'Master is paused'}
                      />
                      <h3>{instance.name}</h3>
                      <span className={instance.enabled ? 'badge badge-done' : 'badge'}>
                        {instance.enabled ? 'Active' : 'Paused'}
                      </span>
                    </div>
                    <div className="orchestrator-actions">
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
                            ? 'Run check now for this master'
                            : 'Start master to check'
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
                        heading={`Delete master "${instance.name}"?`}
                        message="This removes the master orchestrator. Any running agent workers will complete normally."
                        confirmLabel="Delete master"
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
                  <div className="orchestrator-pills">
                    <span className="orchestrator-pill">
                      {instance.strategy === 'observe'
                        ? 'Observe · no worker dispatch'
                        : 'Autonomous board work'}
                    </span>
                    <span className="orchestrator-pill" title="Project scope">
                      📁 {scopeNames}
                    </span>
                    <span className="orchestrator-pill" title="Enabled providers">
                      🤖 {providerNames}
                    </span>
                    <span className="orchestrator-pill" title="Worker concurrency">
                      ⚙ Up to {instance.maxWorkers} workers ({instance.maxWorkersPerProject}/proj ·{' '}
                      {instance.maxWorkersPerProvider}/provider)
                    </span>
                    <span className="orchestrator-pill" title="Quota reserve margin">
                      🛡 {instance.reservePercent}% reserve
                    </span>
                    {instance.followDashboardAttention && (
                      <span
                        className="orchestrator-pill orchestrator-pill-accent"
                        title="Follows Dashboard attention items"
                      >
                        ⚡ Attention follow-up
                      </span>
                    )}
                    {instance.pruneDashboardAttention && (
                      <span
                        className="orchestrator-pill"
                        title="Auto-prunes resolved Dashboard attention tasks"
                      >
                        🧹 Auto-prune attention
                      </span>
                    )}
                    {instance.allowUnknownQuota && (
                      <span
                        className="orchestrator-pill orchestrator-pill-warning"
                        title="Allows dispatching even when provider quota is unknown"
                      >
                        ⚠ Unknown quota allowed
                      </span>
                    )}
                  </div>

                  {preview?.id === instance.id && (
                    <section className="orchestrator-plan-preview" aria-label="Plan preview">
                      <div className="orchestrator-plan-preview-head">
                        <div className="orchestrator-plan-preview-title">
                          <h4>Plan preview</h4>
                          <span className="badge">Snapshot {formatEventTime(preview.data.at)}</span>
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
                          {preview.data.summary.review} review, {preview.data.summary.wait} waiting.{' '}
                          Showing{' '}
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
                              {d.providerBlockers?.length ? (
                                <ul>
                                  {d.providerBlockers.map((blocker) => (
                                    <li key={blocker.providerId}>
                                      {PROVIDER_LABELS[blocker.providerId] ?? blocker.providerId}:{' '}
                                      {blocker.detail}
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                              {d.occupancy && d.occupancy.externalWorkers > 0 && (
                                <span className="faint" style={{ fontSize: '11px', flex: 'none' }}>
                                  Managed: {d.occupancy.managedWorkers} · External:{' '}
                                  {d.occupancy.externalWorkers}
                                </span>
                              )}
                              {d.retry && (
                                <span className="faint" style={{ fontSize: '11px', flex: 'none' }}>
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

                  {/* Board progress summary in scope */}
                  <div className="orchestrator-scope-section">
                    <div className="orchestrator-scope-section-head">
                      <span className="orchestrator-subheading">Scope Board Progress</span>
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

                  {/* Needs Attention queue in scope */}
                  <div className="orchestrator-scope-section orchestrator-attention-section">
                    <div className="orchestrator-scope-section-head">
                      <div className="orchestrator-section-title-group">
                        <span
                          className={`orchestrator-pulse-dot ${totalAttentionCount > 0 ? 'warning' : 'clean'}`}
                          aria-hidden="true"
                        />
                        <span className="orchestrator-subheading">Needs Attention</span>
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
                          title="Queue attention tasks and check this master under its current strategy, quota and worker limits"
                          onClick={() => void resolvePending(instance)}
                        >
                          Resolve attention
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy || totalAttentionCount === 0}
                          title="Prune resolved attention cards and dismiss cleared signals in scope"
                          onClick={() =>
                            void perform(() => api.pruneOrchestratorAttention(instance.id))
                          }
                        >
                          Prune / Dismiss
                        </button>
                      </div>
                    </div>
                    {totalAttentionCount === 0 ? (
                      <p className="faint orchestrator-attention-clean">
                        ✓ No attention items in scope. All projects clean and up to date.
                      </p>
                    ) : (
                      <div className="orchestrator-attention-grid">
                        {scopedProjectAttention.map(({ project: p, kind, detail }) => {
                          const runningRun = activeRuns.find((r) => r.projectId === p.id);
                          const runningSession = activeSessions.find((s) => s.projectId === p.id);
                          const inFlightAttentionCard = scopedInFlightCards.find(
                            (c) =>
                              c.projectId === p.id && c.title.toLowerCase().includes('attention'),
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
                                <Link to={`/projects/${p.id}`} className="attention-proj truncate">
                                  {p.name}
                                </Link>
                                <span className="attention-detail faint truncate" title={detail}>
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
                                        to="/workspace"
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
                                      title="Queue this attention task; dispatch respects pause, strategy, quota and worker limits"
                                      onClick={() => void resolvePending(instance, p.id)}
                                    >
                                      Resolve
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-xs link-button faint"
                                      disabled={busy}
                                      title="Dismiss this attention item without running an agent"
                                      onClick={() =>
                                        void perform(async () => {
                                          await api.dismissOrchestratorAttention(p.id, [kind]);
                                          await api.pruneOrchestratorAttention(instance.id, p.id);
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
                        {failedRunsInScope.map((run) => {
                          const proj = projects.find((p) => p.id === run.projectId);
                          return (
                            <div key={`fail-${run.id}`} className="orchestrator-attention-item">
                              <span className="badge badge-danger">Failed run</span>
                              <div className="attention-item-info">
                                <span className="attention-proj truncate">
                                  {proj?.name ?? `Project ${run.projectId}`}
                                </span>
                                <span
                                  className="attention-detail faint truncate"
                                  title={run.error ?? run.name}
                                >
                                  {run.name}: {run.error ?? 'Execution failed'}
                                </span>
                              </div>
                              <div className="attention-item-actions">
                                <button
                                  type="button"
                                  className="btn btn-xs btn-primary attention-resolve-btn"
                                  disabled={busy}
                                  title="Retry failed run"
                                  onClick={() => void perform(() => api.retryRun(run.id))}
                                >
                                  Retry
                                </button>
                                <Link
                                  to="/workspace"
                                  className="worker-action-link"
                                  title="Open terminal"
                                >
                                  Terminal →
                                </Link>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Being worked on in scope */}
                  <div className="orchestrator-scope-section">
                    <div className="orchestrator-scope-section-head">
                      <div className="orchestrator-section-title-group">
                        <span
                          className={`orchestrator-pulse-dot ${totalBeingWorkedOnCount > 0 ? 'pulse' : ''}`}
                          aria-hidden="true"
                        />
                        <span className="orchestrator-subheading">Being worked on</span>
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
                        No active workers or tasks being worked on in scope.
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
                                {proj && <span className="worker-proj truncate">{proj.name}</span>}
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
                            <div key={`session-${session.id}`} className="orchestrator-worker-card">
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
                                {proj && <span className="worker-proj truncate">{proj.name}</span>}
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
                                  title={card.status === 'in_progress' ? 'In progress' : 'Review'}
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
        )}
      </section>

      {/* Collapsible / context-aware configuration panel */}
      {isFormVisible && (
        <section className="panel orchestrator-form-panel">
          <div className="panel-header">
            <div>
              <h2>{draft.id ? 'Edit orchestrator' : 'New orchestrator'}</h2>
              <p className="faint" style={{ margin: '4px 0 0' }}>
                {draft.id
                  ? `Updating configuration for "${draft.name}"`
                  : 'Define project scope, provider preference, and concurrency rules.'}
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
              <h3 className="orchestrator-form-section-title">Scope & Identity</h3>
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
              <h3 className="orchestrator-form-section-title">Worker Providers & Concurrency</h3>
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
                        setDraft({ ...draft, providers: providers.length ? providers : ['codex'] }),
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
              <h3 className="orchestrator-form-section-title">Policies & Quota</h3>
              <label>
                Strategy
                <Dropdown
                  label="Strategy"
                  value={draft.strategy ?? 'autonomous'}
                  options={[
                    {
                      value: 'observe' as const,
                      label: 'Observe',
                      sub: 'Report board readiness; do not dispatch workers or change attention cards',
                    },
                    {
                      value: 'autonomous' as const,
                      label: 'Autonomous board work',
                      sub: 'Dispatch ready tasks within scope, quota and worker limits; retain review',
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
                    onChange={(e) => setDraft({ ...draft, reservePercent: Number(e.target.value) })}
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
                  Follow up Dashboard attention and uncommitted work
                </label>
                <label className="orchestrator-checkbox">
                  <input
                    type="checkbox"
                    checked={draft.pruneDashboardAttention ?? true}
                    onChange={(e) =>
                      setDraft({ ...draft, pruneDashboardAttention: e.target.checked })
                    }
                  />
                  Auto-prune resolved Dashboard attention tasks
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
      )}
      <section className="panel orchestrator-history-panel">
        <div className="orchestrator-history-header">
          <div className="orchestrator-history-title">
            <h2>Decision history</h2>
            {allCount > 0 && <span className="badge">{allCount}</span>}
          </div>
          {allCount > 0 && (
            <button
              type="button"
              className="link-button faint"
              disabled={busy}
              onClick={() => void perform(() => api.clearOrchestratorEvents())}
            >
              Clear history
            </button>
          )}
        </div>

        {!allCount ? (
          <p className="faint">Decisions appear after the first check.</p>
        ) : (
          <>
            <div
              className="orchestrator-history-filters"
              role="group"
              aria-label="Filter decisions"
            >
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
                Dispatched <span className="work-chip-count num">{dispatchedCount}</span>
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
                  Pruned <span className="work-chip-count num">{prunedCount}</span>
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
              <p className="faint">No decisions match the selected filter.</p>
            ) : (
              <ul className="orchestrator-events">
                {visibleEvents.map((event, index) => {
                  const master = state.instances.find((i) => i.id === event.orchestratorId);
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
                        {state.instances.length > 1 && master && (
                          <span className="event-orchestrator-name faint">({master.name})</span>
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
                  Show older decisions ({reversedEvents.length - historyLimit} remaining)
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
