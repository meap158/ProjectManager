import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useSearchParams } from 'react-router';
import {
  BOARD_PRESETS,
  BOARD_PRESET_COLUMNS,
  BOARD_PRESET_LABELS,
  CARD_STATUS_LABELS,
  type AgentInstall,
  type AgentProviderStatus,
  type BoardPreset,
  type ProjectSummary,
} from '../../../shared/types';
import { useAgentLimits } from '../agentLimits';
import { api } from '../api';
import { AgentPermissionsPanel } from '../components/AgentPermissionsPanel';
import { CodexAccountsPanel } from '../components/CodexAccountsPanel';
import { CpuBudgetPanel } from '../components/CpuBudgetPanel';
import { KeyboardShortcutsPanel } from '../components/KeyboardShortcutsPanel';
import { LanAccessPanel } from '../components/LanAccessPanel';
import { RemoteAccessPanel } from '../components/RemoteAccessPanel';
import { UsageLimits } from '../components/UsageLimits';
import { Dropdown } from '../components/Dropdown';
import { AntigravityAccountsPanel } from '../components/AntigravityAccountsPanel';
import { useViewPreference } from '../useViewPreference';

const TerminalView = lazy(() =>
  import('../components/TerminalView').then((m) => ({ default: m.TerminalView })),
);

const TABS = ['agents', 'access', 'boards', 'shortcuts'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  agents: 'Agents',
  access: 'Access',
  boards: 'Boards',
  shortcuts: 'Shortcuts',
};

/**
 * Settings: sections grouped into tabs — Agents (CLIs, permissions, CPU budget, installs),
 * Access (LAN and remote), Boards and Shortcuts. The tab lives in `?tab=` so it survives reloads.
 */
export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: Tab = TABS.find((t) => t === requested) ?? 'agents';
  const selectTab = (t: Tab) => setParams(t === 'agents' ? {} : { tab: t }, { replace: true });
  function onTabKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const next =
      e.key === 'Home'
        ? TABS[0]
        : e.key === 'End'
          ? TABS[TABS.length - 1]
          : step
            ? TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length]
            : null;
    if (!next) return;
    e.preventDefault();
    selectTab(next);
    document.getElementById(`settings-tab-${next}`)?.focus();
  }
  const [providers, setProviders] = useState<AgentProviderStatus[] | null>(null);
  const [installs, setInstalls] = useState<AgentInstall[] | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [openLog, setOpenLog] = useState<number | null>(null);
  const [expandedCliId, setExpandedCliId] = useViewPreference<string | null>(
    'pm.settings.expandedAccounts',
    null,
    (value): value is string | null =>
      value === null || value === 'codex' || value === 'claude' || value === 'antigravity',
  );
  const [error, setError] = useState<string | null>(null);
  // Plan usage limits per CLI (PM-17) and the clock for "resets in …".
  const limits = useAgentLimits();

  const loadProviders = useCallback(
    (refresh: boolean) =>
      (refresh ? api.listProvidersRefresh() : api.listProviders()).then(setProviders, (e: Error) =>
        setError(e.message),
      ),
    [],
  );
  // Remembers a finished install across polls: PATH availability only flips after work ends,
  // so the provider list refreshes past its cache exactly then.
  const wasInstalling = useRef(false);
  const loadInstalls = useCallback(
    () =>
      api.listInstalls().then(
        (next) => {
          setInstalls(next);
          setError(null);
          const running = next.some((i) => i.status === 'running');
          if (wasInstalling.current && !running) loadProviders(true);
          wasInstalling.current = running;
        },
        (e: Error) => setError(e.message),
      ),
    [loadProviders],
  );

  useEffect(() => {
    loadProviders(false);
    loadInstalls();
    api.listProjects().then(setProjects, (e: Error) => setError(e.message));
  }, [loadProviders, loadInstalls]);

  const installing = installs?.some((i) => i.status === 'running') ?? false;
  useEffect(() => {
    if (!installing) return;
    const timer = setTimeout(loadInstalls, 2000);
    return () => clearTimeout(timer);
  }, [installing, installs, loadInstalls]);

  async function install(providerId: string) {
    try {
      const created = await api.installProvider(providerId);
      setInstalls((prev) => [created, ...(prev ?? [])]);
      setOpenLog(created.id);
      setConfirmId(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function changePreset(projectId: number, preset: BoardPreset) {
    try {
      const updated = await api.setBoardPreset(projectId, preset);
      setProjects((prev) => prev?.map((p) => (p.id === projectId ? updated : p)) ?? prev);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const clis = (providers ?? []).filter((p) => p.id !== 'shell' && p.id !== 'custom');

  return (
    <main className="page">
      <div className="sticky-head">
        <div className="page-header">
          <div>
            <h1>Settings</h1>
            <div className="subtitle">Agent CLIs and app preferences.</div>
          </div>
        </div>
        <div
          className="tabs"
          role="tablist"
          aria-label="Settings sections"
          onKeyDown={onTabKeyDown}
        >
          {TABS.map((t) => (
            <button
              key={t}
              id={`settings-tab-${t}`}
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === t}
              aria-controls={`settings-panel-${t}`}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => selectTab(t)}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div
        className="tab-panel"
        role="tabpanel"
        id="settings-panel-agents"
        aria-labelledby="settings-tab-agents"
        hidden={tab !== 'agents'}
      >
        <section className="panel" aria-label="Agent CLIs">
          <div className="panel-header">
            <h2>Agent CLIs</h2>
            <span className="meta">install what is missing, right here</span>
          </div>
          {providers === null ? (
            <div className="skeleton" style={{ height: 120 }} />
          ) : (
            <ul className="list settings-cli-list">
              {clis.map((p) => {
                const isExpandable =
                  p.id === 'codex' || p.id === 'claude' || p.id === 'antigravity';
                const isExpanded = isExpandable && expandedCliId === p.id;
                const toggleExpand = () =>
                  setExpandedCliId((prev) => (prev === p.id ? null : p.id));
                return (
                  <li
                    key={p.id}
                    className={`settings-cli-item${isExpandable ? ' is-expandable' : ''}${isExpanded ? ' is-expanded' : ''}`}
                  >
                    <div
                      className="settings-cli-row"
                      onClick={
                        isExpandable
                          ? (e) => {
                              if ((e.target as HTMLElement).closest('button, a, input, label')) {
                                return;
                              }
                              toggleExpand();
                            }
                          : undefined
                      }
                    >
                      <span
                        className={`status-dot${p.available ? ' green' : ''}`}
                        role="img"
                        aria-label={p.available ? 'Installed' : 'Not installed'}
                      />
                      <span className="settings-cli-info">
                        <b>{p.name}</b>{' '}
                        <span className="faint" style={{ fontSize: 12.5 }}>
                          {p.description}
                        </span>
                        {!p.available && p.unavailableReason && (
                          <span className="faint" style={{ fontSize: 12.5 }}>
                            {' '}
                            · {p.unavailableReason}
                          </span>
                        )}
                        {limits.list
                          .filter((l) => l.providerId === p.id)
                          .map((l) => (
                            <UsageLimits key={l.providerId} limits={l} now={limits.now} />
                          ))}
                      </span>
                      <span className="settings-cli-actions">
                        {isExpandable && (
                          <button
                            type="button"
                            className="btn btn-sm settings-cli-expand-btn"
                            aria-expanded={isExpanded}
                            aria-controls={`settings-cli-drawer-${p.id}`}
                            onClick={toggleExpand}
                            title={`Switch or manage saved ${p.name} accounts`}
                          >
                            <span>Accounts</span>
                            <span className="blist-caret" aria-hidden="true" />
                          </button>
                        )}
                        {p.available ? (
                          <span className="badge badge-done">installed</span>
                        ) : p.install ? (
                          confirmId === p.id ? (
                            <span className="actions">
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={() => install(p.id)}
                              >
                                Confirm install
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => setConfirmId(null)}
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => setConfirmId(p.id)}
                            >
                              Install
                            </button>
                          )
                        ) : (
                          <span className="faint" style={{ fontSize: 12.5 }}>
                            manual install
                            {p.installUrl && (
                              <>
                                {' '}
                                <a href={p.installUrl} target="_blank" rel="noreferrer">
                                  docs
                                </a>
                              </>
                            )}
                          </span>
                        )}
                      </span>
                    </div>
                    {isExpanded && (
                      <div id={`settings-cli-drawer-${p.id}`} className="settings-cli-drawer">
                        {p.id === 'antigravity' ? (
                          <AntigravityAccountsPanel />
                        ) : (
                          <CodexAccountsPanel
                            providerId={p.id as 'codex' | 'claude'}
                            onError={(msg) => setError(msg || null)}
                          />
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {confirmId && <InstallConfirm provider={clis.find((p) => p.id === confirmId) ?? null} />}
        </section>

        <AgentPermissionsPanel providers={providers} onError={setError} />

        <CpuBudgetPanel onError={setError} />

        {installs !== null && installs.length > 0 && (
          <section className="panel" aria-label="Install history">
            <div className="panel-header">
              <h2>Installs</h2>
              <span className="meta">newest first</span>
            </div>
            <div className="runs">
              {installs.map((install) => (
                <InstallCard
                  key={install.id}
                  install={install}
                  expanded={openLog === install.id}
                  onToggle={() => setOpenLog((prev) => (prev === install.id ? null : install.id))}
                  onDeleted={(id) =>
                    setInstalls((prev) => prev?.filter((x) => x.id !== id) ?? prev)
                  }
                  onError={setError}
                />
              ))}
            </div>
          </section>
        )}
      </div>

      <div
        className="tab-panel"
        role="tabpanel"
        id="settings-panel-access"
        aria-labelledby="settings-tab-access"
        hidden={tab !== 'access'}
      >
        <LanAccessPanel onError={setError} />
        <RemoteAccessPanel onError={setError} />
      </div>

      <div
        className="tab-panel"
        role="tabpanel"
        id="settings-panel-shortcuts"
        aria-labelledby="settings-tab-shortcuts"
        hidden={tab !== 'shortcuts'}
      >
        <KeyboardShortcutsPanel onError={setError} />
      </div>

      <div
        className="tab-panel"
        role="tabpanel"
        id="settings-panel-boards"
        aria-labelledby="settings-tab-boards"
        hidden={tab !== 'boards'}
      >
        <section className="panel" aria-label="Boards">
          <div className="panel-header">
            <h2>Boards</h2>
            <span className="meta">column preset per project</span>
          </div>
          <p className="faint" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
            Fewer columns for focused work. Cards in hidden columns keep their status everywhere
            else — counts, commit auto-moves and validation still see them.
          </p>
          {projects === null ? (
            <div className="skeleton" style={{ height: 80 }} />
          ) : projects.length === 0 ? (
            <p className="faint" style={{ margin: 0 }}>
              No tracked projects yet.
            </p>
          ) : (
            <ul className="list">
              {projects.map((p) => (
                <li key={p.id} className="board-preset-row">
                  <span className="truncate" style={{ flex: 1, minWidth: 0 }} title={p.path}>
                    <b>{p.name}</b>
                  </span>
                  <span className="faint" style={{ fontSize: 12.5 }}>
                    {BOARD_PRESET_COLUMNS[p.boardPreset]
                      .map((s) => CARD_STATUS_LABELS[s])
                      .join(' → ')}
                  </span>
                  <Dropdown
                    label={`Board columns for ${p.name}`}
                    value={p.boardPreset}
                    options={BOARD_PRESETS.map((preset) => ({
                      value: preset,
                      label: BOARD_PRESET_LABELS[preset],
                      sub: BOARD_PRESET_COLUMNS[preset]
                        .map((s) => CARD_STATUS_LABELS[s])
                        .join(' → '),
                    }))}
                    onChange={(preset: BoardPreset) => changePreset(p.id, preset)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

/** What runs on Confirm, shown before anything executes (review before consent). */
function InstallConfirm({ provider }: { provider: AgentProviderStatus | null }) {
  if (!provider?.install) return null;
  const recipe = provider.install;
  return (
    <div className="notice" role="status">
      <span>
        <b>{recipe.label}</b> — {recipe.detail}{' '}
        <a href={recipe.docUrl} target="_blank" rel="noreferrer">
          Official docs
        </a>
      </span>
    </div>
  );
}

function InstallCard({
  install,
  expanded,
  onToggle,
  onDeleted,
  onError,
}: {
  install: AgentInstall;
  expanded: boolean;
  onToggle: () => void;
  onDeleted: (id: number) => void;
  onError: (message: string) => void;
}) {
  const active = install.status === 'running';
  return (
    <div className="run-card">
      <div className="run-head">
        <span
          className={
            install.status === 'succeeded'
              ? 'badge badge-done'
              : install.status === 'failed'
                ? 'badge badge-danger'
                : 'badge'
          }
        >
          {active && <span className="spinner" style={{ width: 10, height: 10 }} />}
          {install.status === 'succeeded' && '✓ '}
          {install.status === 'failed' && '✗ '}
          {install.status}
        </span>
        <span className="truncate" style={{ flex: 1 }}>
          <b>{install.providerName}</b>
        </span>
      </div>
      {install.error && <div className="error-banner">{install.error}</div>}
      {install.status === 'succeeded' && (
        <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
          Installed. If a terminal still reports it missing, open a fresh one so PATH reloads.
        </p>
      )}
      <div className="run-actions">
        <button type="button" className="btn btn-sm" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? 'Hide output' : 'View output'}
        </button>
        <span style={{ flex: 1 }} />
        {!active && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={async () => {
              try {
                await api.deleteInstall(install.id);
                onDeleted(install.id);
              } catch (e) {
                onError((e as Error).message);
              }
            }}
          >
            Dismiss
          </button>
        )}
      </div>
      {expanded && (
        <Suspense fallback={<div className="terminal skeleton" style={{ height: 280 }} />}>
          <TerminalView
            fetchOutput={(after) => api.installOutput(install.id, after)}
            height={280}
          />
        </Suspense>
      )}
    </div>
  );
}
