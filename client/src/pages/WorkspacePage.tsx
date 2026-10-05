import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  WORKSPACE_FONT_SIZES,
  WORKSPACE_PRESETS,
  WORKSPACE_PRESET_INFO,
  type AgentProviderStatus,
  type AgentRun,
  type AgentSession,
  type AgentTokenUsage,
  type ProjectSummary,
  type WorkspaceLayout,
  type WorkspacePreset,
} from '../../../shared/types';
import { api } from '../api';
import { Dropdown } from '../components/Dropdown';
import { InlineRename } from '../components/InlineRename';
import { AgentWorkList, mergeWork, type WorkItem, type WorkKey } from '../components/AgentWorkList';
import { ConfirmDelete } from '../components/ConfirmDelete';
import { RunCard } from '../components/RunCard';

// xterm is heavy: it loads only when a pane actually shows a terminal.
const TerminalView = lazy(() =>
  import('../components/TerminalView').then((m) => ({ default: m.TerminalView })),
);

const SESSIONS_POLL_MS = 4000;
const VIEW_KEY = 'pm.workspace.view';
type View = 'panes' | 'list';

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'panes';
  } catch {
    return 'panes';
  }
}
const SAVE_DEBOUNCE_MS = 300;
/** Grow order when a session is opened and every pane is taken. */
const GROW: Partial<Record<WorkspacePreset, WorkspacePreset>> = {
  '1': '2v',
  '2v': '2x2',
  '2h': '2x2',
  '3v': '2x2',
};

/** Re-fit a pane list to a preset: keep sessions in order, drop empties first, pad with null. */
function fitPanes(panes: (number | null)[], preset: WorkspacePreset): (number | null)[] {
  const count = WORKSPACE_PRESET_INFO[preset].panes;
  const kept = panes.filter((p): p is number => p !== null).slice(0, count);
  return [...kept, ...Array<null>(count - kept.length).fill(null)];
}

/** Place a session in the layout: already shown → keep; else first empty pane; else grow the
    preset; else replace the last pane. */
export function placeSession(layout: WorkspaceLayout, sessionId: number): WorkspaceLayout {
  if (layout.panes.includes(sessionId)) return layout;
  let { preset, panes } = layout;
  if (!panes.includes(null) && GROW[preset]) {
    preset = GROW[preset]!;
    panes = fitPanes(panes, preset);
  }
  const at = panes.indexOf(null);
  const next = [...panes];
  next[at === -1 ? next.length - 1 : at] = sessionId;
  return { preset, panes: next, maximized: null };
}

/**
 * The agent workspace: terminal panes for sessions from any project, side by side. Layout presets
 * keep it simple; the layout and pane contents persist server-side. Only visible panes mount a
 * terminal and a live stream, so many sessions stay cheap.
 */
export function WorkspacePage() {
  const [params, setParams] = useSearchParams();
  const [layout, setLayout] = useState<WorkspaceLayout | null>(null);
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [providers, setProviders] = useState<AgentProviderStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  // List view: every session and run across projects, one row each (same rows as a project's
  // Agents tab). Runs and token counts load only while the list is shown.
  const [view, setViewState] = useState<View>(readView);
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [usage, setUsage] = useState<Record<number, AgentTokenUsage | null>>({});
  const [selectedRun, setSelectedRun] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const setView = (next: View) => {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Remembering the view is a convenience only.
    }
  };

  const loadSessions = useCallback(
    () => api.listAllSessions().then(setSessions, (e: Error) => setError(e.message)),
    [],
  );

  const loadedLayout = useRef<WorkspaceLayout | null>(null);
  useEffect(() => {
    // Ignore responses that land after cleanup (StrictMode's double mount, fast navigation):
    // a late layout response would overwrite changes made since, such as an opened session.
    let active = true;
    api.getWorkspace().then(
      (saved) => {
        if (!active) return;
        loadedLayout.current = saved;
        setLayout(saved);
      },
      (e: Error) => active && setError(e.message),
    );
    api.listProjects().then(
      (p) => active && setProjects(p),
      () => undefined,
    );
    api.listProviders().then(
      (p) => active && setProviders(p),
      () => undefined,
    );
    loadSessions();
    const timer = setInterval(loadSessions, SESSIONS_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [loadSessions]);

  useEffect(() => {
    if (view !== 'list') return;
    let active = true;
    const load = () => {
      api.listAllRuns().then(
        (r) => {
          if (!active) return;
          setRuns(r);
          setNow(Date.now());
        },
        (e: Error) => active && setError(e.message),
      );
    };
    load();
    const timer = setInterval(load, SESSIONS_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [view]);
  const claudeIds = (sessions ?? [])
    .filter((s) => s.providerId === 'claude')
    .map((s) => s.id)
    .join(',');
  useEffect(() => {
    if (view !== 'list' || !claudeIds) return;
    api.sessionUsage(claudeIds.split(',').map(Number)).then(setUsage, () => undefined);
  }, [view, claudeIds, runs]);

  // Persist every layout change after the initial load (debounced) so it survives reloads,
  // restarts and reboots.
  useEffect(() => {
    if (!layout || layout === loadedLayout.current) return;
    const timer = setTimeout(() => {
      api.saveWorkspace(layout).catch((e: Error) => setError(e.message));
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [layout]);
  const update = setLayout;

  // `?open=<sessionId>` (from a Kanban card or the Agents tab) puts that session in a pane.
  // Applied while rendering (React's "adjust state on prop change" pattern), then the param is
  // cleared so a reload doesn't re-apply it.
  const openParam = Number(params.get('open')) || null;
  const [handledOpen, setHandledOpen] = useState<number | null>(null);
  if (layout && openParam && openParam !== handledOpen) {
    setHandledOpen(openParam);
    setLayout(placeSession(layout, openParam));
  }
  useEffect(() => {
    if (!openParam || openParam !== handledOpen) return;
    setParams({}, { replace: true });
    loadSessions(); // The opened session may be newer than our last poll.
  }, [openParam, handledOpen, setParams, loadSessions]);

  const byId = useMemo(() => new Map((sessions ?? []).map((s) => [s.id, s])), [sessions]);
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  // Keyboard: Alt+1..4 focuses pane N (switching the maximised pane when one is maximised),
  // Alt+Enter toggles maximise for the focused pane. Captured before xterm sees the keys.
  useEffect(() => {
    if (!layout) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const focusedPane = () => {
        const el = document.activeElement?.closest<HTMLElement>('[data-pane]');
        return el ? Number(el.dataset.pane) : null;
      };
      if (/^Digit[1-4]$/.test(event.code)) {
        const index = Number(event.code.slice(5)) - 1;
        if (index >= layout.panes.length) return;
        event.preventDefault();
        event.stopPropagation();
        if (layout.maximized !== null && layout.maximized !== index) {
          setLayout({ ...layout, maximized: index });
        }
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>(`[data-pane="${index}"] .xterm-helper-textarea`)
            ?.focus(),
        );
      } else if (event.key === 'Enter') {
        const index = focusedPane();
        if (index === null) return;
        event.preventDefault();
        event.stopPropagation();
        setLayout({ ...layout, maximized: layout.maximized === index ? null : index });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [layout]);

  // Drag a pane header onto another pane to swap them.
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropOn, setDropOn] = useState<number | null>(null);
  const swapPanes = (from: number, to: number) => {
    if (!layout || from === to) return;
    const panes = [...layout.panes];
    [panes[from], panes[to]] = [panes[to] ?? null, panes[from] ?? null];
    setLayout({ ...layout, panes });
  };
  const dropProps = (index: number) => ({
    dropActive: dropOn === index && dragFrom !== null && dragFrom !== index,
    onDragOver: (event: React.DragEvent) => {
      if (dragFrom === null) return;
      event.preventDefault();
      if (dropOn !== index) setDropOn(index);
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      if (dragFrom !== null) swapPanes(dragFrom, index);
      setDragFrom(null);
      setDropOn(null);
    },
  });

  if (!layout) {
    return (
      <main className="workspace" aria-busy="true">
        {error ? (
          <div className="error-banner">{error}</div>
        ) : (
          <div className="skeleton" style={{ flex: 1 }} />
        )}
      </main>
    );
  }

  const info = WORKSPACE_PRESET_INFO[layout.preset];
  const fontSize = layout.fontSize ?? WORKSPACE_FONT_SIZES.default;
  const visible =
    layout.maximized !== null && layout.panes[layout.maximized] !== undefined
      ? [layout.maximized]
      : layout.panes.map((_, i) => i);

  return (
    <main className="workspace">
      <div className="workspace-bar">
        <h1>Agents</h1>
        <div className="bar-group">
          <span className="bar-label" id="ws-view-label">
            View
          </span>
          <div className="view-switch" role="radiogroup" aria-labelledby="ws-view-label">
            {(['panes', 'list'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                className={`btn btn-sm${view === v ? ' is-active' : ''}`}
                title={
                  v === 'panes'
                    ? 'Terminals side by side'
                    : 'Every session and run across projects, one row each'
                }
                onClick={() => setView(v)}
              >
                {v === 'panes' ? 'Panes' : 'List'}
              </button>
            ))}
          </div>
        </div>
        {view === 'panes' && (
          <>
            <div className="bar-group">
              <span className="bar-label" id="ws-layout-label">
                Layout
              </span>
              <div className="preset-picker" role="radiogroup" aria-labelledby="ws-layout-label">
                {WORKSPACE_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    role="radio"
                    aria-checked={layout.preset === preset}
                    aria-label={WORKSPACE_PRESET_INFO[preset].label}
                    title={WORKSPACE_PRESET_INFO[preset].label}
                    className={`preset${layout.preset === preset ? ' is-active' : ''}`}
                    onClick={() =>
                      update({ preset, panes: fitPanes(layout.panes, preset), maximized: null })
                    }
                  >
                    <PresetIcon preset={preset} />
                  </button>
                ))}
              </div>
            </div>
            <div className="bar-group">
              <span className="bar-label" id="ws-text-label">
                Text size
              </span>
              <div className="stepper" role="group" aria-labelledby="ws-text-label">
                <button
                  type="button"
                  aria-label="Smaller terminal text"
                  disabled={fontSize <= WORKSPACE_FONT_SIZES.min}
                  onClick={() => update({ ...layout, fontSize: fontSize - 1 })}
                >
                  −
                </button>
                <span className="num" aria-live="polite">
                  {fontSize}
                </span>
                <button
                  type="button"
                  aria-label="Larger terminal text"
                  disabled={fontSize >= WORKSPACE_FONT_SIZES.max}
                  onClick={() => update({ ...layout, fontSize: fontSize + 1 })}
                >
                  +
                </button>
              </div>
            </div>
            <ShortcutsHelp />
          </>
        )}
        <NewSessionInline
          projects={projects}
          providers={providers}
          onCreated={(s) => {
            setSessions((prev) => [...(prev ?? []), s]);
            update(placeSession(layout, s.id));
          }}
          onError={setError}
        />
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}{' '}
          <button className="btn btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {view === 'list' ? (
        <WorkList
          sessions={sessions}
          runs={runs}
          now={now}
          usage={usage}
          projectName={projectName}
          selectedRun={selectedRun}
          onSelectRun={setSelectedRun}
          onShowInPane={(id) => {
            update(placeSession(layout, id));
            setView('panes');
          }}
          onSessionChanged={(next) =>
            setSessions((prev) => prev?.map((x) => (x.id === next.id ? next : x)) ?? prev)
          }
          onSessionDeleted={(id) => setSessions((prev) => prev?.filter((x) => x.id !== id) ?? prev)}
          onRunChanged={(next) =>
            setRuns((prev) => prev?.map((x) => (x.id === next.id ? next : x)) ?? [next])
          }
          onRunDeleted={(id) => setRuns((prev) => prev?.filter((x) => x.id !== id) ?? prev)}
          onError={setError}
        />
      ) : (
        <div
          className="pane-grid"
          style={
            visible.length === 1
              ? { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' }
              : {
                  gridTemplateColumns: `repeat(${info.columns}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${info.rows}, minmax(0, 1fr))`,
                }
          }
        >
          {visible.map((index) => {
            const sessionId = layout.panes[index] ?? null;
            const session = sessionId !== null ? byId.get(sessionId) : undefined;
            const setPane = (id: number | null) => {
              const panes = [...layout.panes];
              panes[index] = id;
              update({ ...layout, panes, maximized: id === null ? null : layout.maximized });
            };
            return session ? (
              <Pane
                key={`${index}-${session.id}`}
                index={index}
                fontSize={fontSize}
                onDragStart={() => setDragFrom(index)}
                onDragEnd={() => {
                  setDragFrom(null);
                  setDropOn(null);
                }}
                {...dropProps(index)}
                session={session}
                projectName={projectName.get(session.projectId) ?? `Project ${session.projectId}`}
                agentName={
                  session.providerId === 'custom'
                    ? (session.command[0] ?? 'Custom command')
                    : (providers.find((p) => p.id === session.providerId)?.name ??
                      session.providerId)
                }
                maximized={layout.maximized === index}
                onToggleMaximize={() =>
                  update({ ...layout, maximized: layout.maximized === index ? null : index })
                }
                onClose={() => setPane(null)}
                onChanged={(next) =>
                  setSessions((prev) => prev?.map((s) => (s.id === next.id ? next : s)) ?? prev)
                }
                onError={setError}
              />
            ) : (
              <EmptyPane
                key={`${index}-empty`}
                index={index}
                {...dropProps(index)}
                sessions={(sessions ?? []).filter((s) => !layout.panes.includes(s.id))}
                loading={sessions === null}
                projectName={projectName}
                onPick={(id) => setPane(id)}
              />
            );
          })}
        </div>
      )}
    </main>
  );
}

interface DropTargetProps {
  dropActive: boolean;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
}

function Pane({
  index,
  fontSize,
  onDragStart,
  onDragEnd,
  dropActive,
  onDragOver,
  onDrop,
  session: s,
  projectName,
  agentName,
  maximized,
  onToggleMaximize,
  onClose,
  onChanged,
  onError,
}: DropTargetProps & {
  index: number;
  fontSize: number;
  onDragStart: () => void;
  onDragEnd: () => void;
  session: AgentSession;
  projectName: string;
  /** Which CLI runs in the pane, e.g. "Claude Code". */
  agentName: string;
  maximized: boolean;
  onToggleMaximize: () => void;
  onClose: () => void;
  onChanged: (s: AgentSession) => void;
  onError: (message: string) => void;
}) {
  const running = s.status === 'running';
  // Keystrokes batched per ~frame and sent strictly in order (fast typing and pastes stay intact).
  const buffer = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const sendKeys = (data: string) => {
    buffer.current += data;
    if (timer.current) return;
    timer.current = setTimeout(() => {
      const chunk = buffer.current;
      buffer.current = '';
      timer.current = null;
      chain.current = chain.current
        .then(() => api.sendSessionInput(s.id, chunk))
        .catch((e: Error) => onError(e.message));
    }, 12);
  };
  const [line, setLine] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [cardNote, setCardNote] = useState<string | null>(null);

  /** Hand the linked card on to Review once the work in this session looks done. */
  async function sendCardToReview() {
    if (!s.cardId) return;
    try {
      await api.updateCard(s.cardId, { status: 'review' });
      setCardNote(`${s.cardKey} → Review`);
      setTimeout(() => setCardNote(null), 2500);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  async function act(fn: () => Promise<AgentSession>) {
    try {
      onChanged(await fn());
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <section
      className={`pane${maximized ? ' is-maximized' : ''}${dropActive ? ' drop-target' : ''}`}
      aria-label={`${s.name} terminal (pane ${index + 1})`}
      data-pane={index}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <header
        className="pane-head"
        onDoubleClick={onToggleMaximize}
        title="Double-click to maximise · drag onto another pane to swap"
        draggable={!renaming}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', s.name);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
      >
        <span className="pane-index faint num" aria-hidden="true">
          {index + 1}
        </span>
        <span
          className="status-dot"
          style={{
            background: running
              ? 'var(--good)'
              : s.status === 'dead'
                ? 'var(--danger)'
                : 'var(--series-other)',
          }}
          role="img"
          aria-label={running ? 'Running' : `Ended (${s.status})`}
        />
        <InlineRename
          value={s.name}
          label="session"
          onEditingChange={setRenaming}
          onSave={(name) =>
            api.patchSession(s.id, { name }).then(onChanged, (e: Error) => onError(e.message))
          }
        />
        <span className="pane-meta faint">
          {/* Skipped when the session is simply named after its agent ("Shell"). */}
          {agentName !== s.name && (
            <>
              <span className="pane-agent" title="Agent running in this session">
                {agentName}
              </span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <Link to={`/projects/${s.projectId}?tab=agents`} className="truncate">
            {projectName}
          </Link>
          {s.cardKey && (
            <>
              <span aria-hidden="true">·</span>
              <Link to={`/projects/${s.projectId}?tab=board`} className="mono">
                {s.cardKey}
              </Link>
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                title={`Unlink ${s.cardKey} from this session (the session keeps running)`}
                aria-label={`Unlink ${s.cardKey}`}
                onClick={() =>
                  api.attachCardToSession(s.id, null).then(
                    (r) => onChanged(r.session),
                    (e: Error) => onError(e.message),
                  )
                }
              >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path
                    d="M2 2l6 6M8 2l-6 6"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </>
          )}
        </span>
        <span style={{ flex: 1 }} />
        {cardNote && (
          <span className="badge badge-live" role="status">
            {cardNote}
          </span>
        )}
        {s.cardId && !cardNote && (
          <button
            className="icon-btn icon-btn-text"
            title={`Move ${s.cardKey} to Review`}
            onClick={sendCardToReview}
          >
            → Review
          </button>
        )}
        {running ? (
          <button
            className="icon-btn"
            title="Stop session"
            onClick={() => act(() => api.stopSession(s.id))}
          >
            ■
          </button>
        ) : (
          <button
            className="icon-btn"
            title="Start session"
            onClick={() => act(() => api.startSession(s.id))}
          >
            ▶
          </button>
        )}
        <button
          className="icon-btn"
          title={maximized ? 'Restore layout' : 'Maximise pane'}
          aria-pressed={maximized}
          onClick={onToggleMaximize}
        >
          {maximized ? '⤡' : '⤢'}
        </button>
        <button
          className="icon-btn"
          title="Remove from layout (keeps the session running)"
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <div className="pane-body">
        <Suspense fallback={<div className="terminal skeleton" style={{ height: '100%' }} />}>
          <TerminalView
            key={`${s.id}-${s.terminal}`}
            height="100%"
            fontSize={fontSize}
            fetchOutput={(after) => api.sessionOutput(s.id, after)}
            streamUrl={(after) => api.sessionStreamUrl(s.id, after)}
            {...(s.terminal === 'pty'
              ? {
                  onInput: sendKeys,
                  onResize: (cols: number, rows: number) => {
                    api.resizeSession(s.id, cols, rows).catch(() => undefined);
                  },
                }
              : {})}
          />
        </Suspense>
      </div>
      {s.terminal === 'pipe' && (
        <form
          className="pane-input"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!line) return;
            api.sendSessionInput(s.id, line + '\n').catch((err: Error) => onError(err.message));
            setLine('');
          }}
        >
          <input
            className="input mono"
            value={line}
            onChange={(e) => setLine(e.target.value)}
            placeholder="Line input (pipe session)…"
            aria-label="Session input"
          />
        </form>
      )}
    </section>
  );
}

function EmptyPane({
  index,
  dropActive,
  onDragOver,
  onDrop,
  sessions,
  loading,
  projectName,
  onPick,
}: DropTargetProps & {
  index: number;
  sessions: AgentSession[];
  loading: boolean;
  projectName: Map<number, string>;
  onPick: (sessionId: number) => void;
}) {
  // Running sessions first, newest first.
  const sorted = [...sessions].sort(
    (a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.id - a.id,
  );
  return (
    <section
      className={`pane pane-empty${dropActive ? ' drop-target' : ''}`}
      aria-label={`Empty pane ${index + 1}`}
      data-pane={index}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {loading ? (
        <div className="skeleton" style={{ flex: 1 }} />
      ) : sorted.length === 0 ? (
        <p className="faint">
          No other sessions. Start one above, or open a card on a project&apos;s Board and choose
          “Work on it in a terminal”.
        </p>
      ) : (
        <>
          <h3>Show a session here</h3>
          <ul className="list">
            {sorted.map((s) => (
              <li key={s.id}>
                <button className="session-pick" onClick={() => onPick(s.id)}>
                  <span
                    className="status-dot"
                    style={{
                      background: s.status === 'running' ? 'var(--good)' : 'var(--series-other)',
                    }}
                    aria-hidden="true"
                  />
                  <b className="truncate">{s.name}</b>
                  <span className="faint truncate">{projectName.get(s.projectId) ?? ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function NewSessionInline({
  projects,
  providers,
  onCreated,
  onError,
}: {
  projects: ProjectSummary[];
  providers: AgentProviderStatus[];
  onCreated: (s: AgentSession) => void;
  onError: (message: string) => void;
}) {
  const [projectId, setProjectId] = useState<number | ''>('');
  const [providerId, setProviderId] = useState('claude');
  const [busy, setBusy] = useState(false);
  const usable = providers.filter((p) => p.id !== 'custom');
  const chosen = projectId || projects[0]?.id;

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!chosen) return;
    setBusy(true);
    try {
      onCreated(await api.createSession(chosen, { providerId }));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="workspace-new" onSubmit={start} aria-label="Start a new session">
      <span className="bar-label">New session in</span>
      <Dropdown
        label="Project"
        value={chosen ?? ''}
        options={projects.map((p) => ({ value: p.id, label: p.name, title: p.path }))}
        onChange={(v) => setProjectId(v)}
      />
      <span className="bar-label">with</span>
      <Dropdown
        label="Agent"
        value={providerId}
        options={usable.map((p) => ({
          value: p.id,
          label: p.name,
          disabled: !p.available,
          hint: !p.available ? 'not on PATH' : undefined,
          title: p.unavailableReason ?? p.description,
        }))}
        onChange={setProviderId}
      />
      <button className="btn btn-primary btn-sm" disabled={busy || !chosen}>
        Start
      </button>
    </form>
  );
}

/** Keyboard/mouse shortcuts behind a "?" button: discoverable without permanent clutter. */
function ShortcutsHelp() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent | KeyboardEvent) => {
      const el = ref.current;
      if (!el?.open) return;
      if (
        event instanceof KeyboardEvent ? event.key === 'Escape' : !el.contains(event.target as Node)
      ) {
        el.open = false;
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  return (
    <details className="shortcuts" ref={ref}>
      <summary aria-label="Keyboard shortcuts" title="Keyboard shortcuts">
        ?
      </summary>
      <div className="shortcuts-pop" role="note">
        <b>Shortcuts</b>
        <dl>
          <dt>
            <kbd>Alt</kbd> + <kbd>1</kbd>…<kbd>4</kbd>
          </dt>
          <dd>Focus pane 1–4</dd>
          <dt>
            <kbd>Alt</kbd> + <kbd>Enter</kbd>
          </dt>
          <dd>Maximise / restore the focused pane</dd>
          <dt>Double-click a header</dt>
          <dd>Maximise / restore</dd>
          <dt>Drag a header</dt>
          <dd>Swap two panes</dd>
        </dl>
      </div>
    </details>
  );
}

function PresetIcon({ preset }: { preset: WorkspacePreset }) {
  const { columns, rows } = WORKSPACE_PRESET_INFO[preset];
  const cells = [];
  const w = 14 / columns;
  const h = 10 / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      cells.push(
        <rect
          key={`${r}-${c}`}
          x={1 + c * w + 0.6}
          y={1 + r * h + 0.6}
          width={w - 1.2}
          height={h - 1.2}
          rx={1}
        />,
      );
    }
  }
  return (
    <svg viewBox="0 0 16 12" width="20" height="15" aria-hidden="true">
      {cells}
    </svg>
  );
}

/** List view: every session and run across projects. Sessions open into a pane; runs expand. */
function WorkList({
  sessions,
  runs,
  now,
  usage,
  projectName,
  selectedRun,
  onSelectRun,
  onShowInPane,
  onSessionChanged,
  onSessionDeleted,
  onRunChanged,
  onRunDeleted,
  onError,
}: {
  sessions: AgentSession[] | null;
  runs: AgentRun[] | null;
  now: number;
  usage: Record<number, AgentTokenUsage | null>;
  projectName: Map<number, string>;
  selectedRun: number | null;
  onSelectRun: (id: number | null) => void;
  onShowInPane: (sessionId: number) => void;
  onSessionChanged: (s: AgentSession) => void;
  onSessionDeleted: (id: number) => void;
  onRunChanged: (r: AgentRun) => void;
  onRunDeleted: (id: number) => void;
  onError: (message: string) => void;
}) {
  if (!sessions || !runs) return <div className="skeleton" style={{ flex: 1 }} />;
  const items = mergeWork(sessions, runs);
  const run = runs.find((r) => r.id === selectedRun) ?? null;
  const change = (fn: () => Promise<AgentSession>) =>
    fn().then(onSessionChanged, (e: Error) => onError(e.message));

  const actions = (w: WorkItem) => {
    if (w.kind !== 'session') return null;
    const s = w.item;
    return (
      <>
        <button
          type="button"
          className="btn btn-sm"
          title="Put this session in a pane"
          onClick={() => onShowInPane(s.id)}
        >
          Show in pane
        </button>
        {s.status === 'running' ? (
          <button
            type="button"
            className="btn btn-sm"
            title="Stop the process (it won't relaunch until you start it)"
            onClick={() => change(() => api.stopSession(s.id))}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            title={s.resumeSupported ? 'Start again, resuming the conversation' : 'Start again'}
            onClick={() => change(() => api.startSession(s.id))}
          >
            Start
          </button>
        )}
        <ConfirmDelete
          label={`Delete session "${s.name}"`}
          heading={`Delete session "${s.name}"?`}
          message="Stops the process if it's running and deletes its log. This can't be undone."
          onConfirm={() =>
            api.deleteSession(s.id).then(
              () => onSessionDeleted(s.id),
              (e: Error) => onError(e.message),
            )
          }
        />
      </>
    );
  };

  return (
    <section className="panel workspace-list" aria-label="All agent work">
      <div className="panel-header">
        <h2>All agent work</h2>
        <span className="meta">
          {sessions.length} session{sessions.length === 1 ? '' : 's'} · {runs.length} run
          {runs.length === 1 ? '' : 's'} across projects
        </span>
      </div>
      {items.length === 0 ? (
        <p className="faint" style={{ margin: 0 }}>
          Nothing yet. Start a session from the toolbar, or hand a card to an agent from a board.
        </p>
      ) : (
        <AgentWorkList
          items={items}
          selected={run ? `run:${run.id}` : null}
          onSelect={(key: WorkKey) => {
            const [kind, id] = key.split(':');
            if (kind === 'session') onShowInPane(Number(id));
            else onSelectRun(Number(id) === selectedRun ? null : Number(id));
          }}
          now={now}
          tokens={usage}
          projectNames={projectName}
          actions={actions}
        />
      )}
      {run && (
        <div className="runs">
          <RunCard
            run={run}
            now={now}
            onChanged={onRunChanged}
            onDeleted={(id) => {
              onRunDeleted(id);
              onSelectRun(null);
            }}
          />
        </div>
      )}
    </section>
  );
}
