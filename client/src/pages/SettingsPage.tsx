import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
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
import type { ProviderLimits } from '../../../shared/limits';
import { api } from '../api';
import { AgentPermissionsPanel } from '../components/AgentPermissionsPanel';
import { LanAccessPanel } from '../components/LanAccessPanel';
import { UsageLimits } from '../components/UsageLimits';
import { Dropdown } from '../components/Dropdown';

const TerminalView = lazy(() =>
  import('../components/TerminalView').then((m) => ({ default: m.TerminalView })),
);

/**
 * Settings: one section per concern (KDP pattern — sections grow here as needed).
 * Today: agent CLIs, with one-click installs for whatever is missing.
 */
export function SettingsPage() {
  const [providers, setProviders] = useState<AgentProviderStatus[] | null>(null);
  const [installs, setInstalls] = useState<AgentInstall[] | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [openLog, setOpenLog] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Plan usage limits per CLI (PM-17) and the clock for "resets in …", refreshed together.
  const [limits, setLimits] = useState<{ list: ProviderLimits[]; now: number }>({
    list: [],
    now: 0,
  });
  useEffect(() => {
    let active = true;
    const load = () =>
      api.agentLimits().then(
        (list) => active && setLimits({ list, now: Date.now() }),
        // Advisory: a failed read leaves the rows as they are.
        () => undefined,
      );
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

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
      </div>

      {error && <div className="error-banner">{error}</div>}

      <section className="panel" aria-label="Agent CLIs">
        <div className="panel-header">
          <h2>Agent CLIs</h2>
          <span className="meta">install what is missing, right here</span>
        </div>
        {providers === null ? (
          <div className="skeleton" style={{ height: 120 }} />
        ) : (
          <ul className="list">
            {clis.map((p) => (
              <li key={p.id}>
                <span
                  className={`status-dot${p.available ? ' green' : ''}`}
                  role="img"
                  aria-label={p.available ? 'Installed' : 'Not installed'}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
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
                    <button type="button" className="btn btn-sm" onClick={() => setConfirmId(p.id)}>
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
              </li>
            ))}
          </ul>
        )}
        {confirmId && <InstallConfirm provider={clis.find((p) => p.id === confirmId) ?? null} />}
      </section>

      <AgentPermissionsPanel providers={providers} onError={setError} />

      <LanAccessPanel onError={setError} />

      <section className="panel" aria-label="Boards">
        <div className="panel-header">
          <h2>Boards</h2>
          <span className="meta">column preset per project</span>
        </div>
        <p className="faint" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
          Fewer columns for focused work. Cards in hidden columns keep their status everywhere else
          — counts, commit auto-moves and validation still see them.
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
                    sub: BOARD_PRESET_COLUMNS[preset].map((s) => CARD_STATUS_LABELS[s]).join(' → '),
                  }))}
                  onChange={(preset: BoardPreset) => changePreset(p.id, preset)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

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
                onDeleted={(id) => setInstalls((prev) => prev?.filter((x) => x.id !== id) ?? prev)}
                onError={setError}
              />
            ))}
          </div>
        </section>
      )}
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
