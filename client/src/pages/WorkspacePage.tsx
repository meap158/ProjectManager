import './agents-toolbar.css';
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { ProviderIcon } from '../components/icons';
import { Link, useNavigate, useSearchParams } from 'react-router';
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
import {
  NO_FILTERS,
  WorkFilters,
  applyWorkFilters,
  selectedFilters,
  useWorkFilters,
} from '../components/WorkFilters';
import { WorkSorter, sortWork, useWorkSort } from '../components/WorkSorter';
import { readLastAgent, saveLastAgent } from '../lastAgent';
import { isTerminalReport } from '../../../shared/terminalReports';
import { SessionChat, ViewSwitch, useSessionView } from '../components/SessionChat';
import { TerminalInputQueue } from '../lib/terminalInputQueue';
import { serialPoll } from '../lib/serialPoll';
import { ACTIVITY_LABEL, sessionActivity } from '../sessionActivity';
import { useShortcutProps, useShortcutTitle } from '../shortcuts';
import { AgentWorkList, mergeWork, type WorkItem, type WorkKey } from '../components/AgentWorkList';
import { ConfirmDelete } from '../components/ConfirmDelete';
import { BatchAttentionActions } from '../components/BatchAttentionActions';
import { BatchSessionMessage } from '../components/BatchSessionMessage';
import { SessionToggle } from '../components/SessionToggle';
import { SessionContinue } from '../components/SessionContinue';
import { RunCard } from '../components/RunCard';
import { LimitsStrip } from '../components/LimitsStrip';
import { SessionImageButton } from '../components/SessionImageButton';
import { SessionProgress, SessionRestartStatus } from '../components/SessionProgress';
import { sendImageToSession } from '../sessionImages';

// Preload TerminalView chunk as soon as workspace module loads so it is ready when panes render.
const terminalViewPromise = import('../components/TerminalView');
const TerminalView = lazy(() => terminalViewPromise.then((m) => ({ default: m.TerminalView })));

// Memory cache: returning to /workspace renders previous layout and sessions immediately
// without showing an empty skeleton banner while waiting for network fetches.
let cachedWorkspaceLayout: WorkspaceLayout | null = null;

const SELECTED_KEY = 'pm.workspace.selected';
function readSelectedWork(): WorkKey | null {
  try {
    const value = sessionStorage.getItem(SELECTED_KEY);
    return value && /^(session|run):\d+$/.test(value) ? (value as WorkKey) : null;
  } catch {
    return null;
  }
}
function saveSelectedWork(key: WorkKey | null): void {
  try {
    if (key) sessionStorage.setItem(SELECTED_KEY, key);
    else sessionStorage.removeItem(SELECTED_KEY);
  } catch {
    // Private mode: the selection just isn't remembered.
  }
}
let cachedSessions: AgentSession[] | null = null;

export function resetWorkspaceCache(): void {
  cachedWorkspaceLayout = null;
  cachedSessions = null;
}

const SESSIONS_POLL_MS = 4000;
const VIEW_KEY = 'pm.workspace.view';
/** The phone pane-count picker's choices: stacked panes, so one preset per count. */
const PHONE_PRESETS: [number, WorkspacePreset][] = [
  [1, '1'],
  [2, '2h'],
  [3, '3v'],
  [4, '2x2'],
];
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

/** Shrink order when an empty pane is closed (PM-63): one pane fewer, same family of layouts. */
const SHRINK: Partial<Record<WorkspacePreset, WorkspacePreset>> = {
  '2x2': '3v',
  '3v': '2v',
  '2v': '1',
  '2h': '1',
};

/** Re-fit a pane list to a preset: keep sessions in order, drop empties first, pad with null. */
function fitPanes(panes: (number | null)[], preset: WorkspacePreset): (number | null)[] {
  const count = WORKSPACE_PRESET_INFO[preset].panes;
  const kept = panes.filter((p): p is number => p !== null).slice(0, count);
  return [...kept, ...Array<null>(count - kept.length).fill(null)];
}

/**
 * Close an empty pane: the grid gets one pane smaller (2×2 → three columns → two → one) and every
 * session stays, in order. The layout is unchanged when the pane holds a session or there is no
 * smaller layout.
 */
export function closeEmptyPane(layout: WorkspaceLayout, index: number): WorkspaceLayout {
  const preset = SHRINK[layout.preset];
  if (!preset || layout.panes[index] !== null) return layout;
  const panes = fitPanes(
    layout.panes.filter((_, i) => i !== index),
    preset,
  );
  return { preset, panes, maximized: null };
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
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [layout, setLayout] = useState<WorkspaceLayout | null>(() => cachedWorkspaceLayout);
  const [sessions, setSessions] = useState<AgentSession[] | null>(
    () => cachedSessions?.filter((s) => !s.orchestratorId) ?? null,
  );
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [providers, setProviders] = useState<AgentProviderStatus[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cachedWorkspaceLayout = layout;
  }, [layout]);

  useEffect(() => {
    cachedSessions = sessions;
  }, [sessions]);
  // List view: every session and run across projects, one row each (same rows as a project's
  // Agents tab). Runs and token counts load only while the list is shown.
  const [view, setViewState] = useState<View>(readView);
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [usage, setUsage] = useState<Record<number, AgentTokenUsage | null>>({});
  // The open terminal in List view survives leaving the page and coming back (PM-72).
  const [selectedWork, setSelectedWorkState] = useState<WorkKey | null>(readSelectedWork);
  const setSelectedWork = (key: WorkKey | null) => {
    setSelectedWorkState(key);
    saveSelectedWork(key);
  };
  const [now, setNow] = useState(0);
  const [mobileNewOpen, setMobileNewOpen] = useState(false);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const setView = (next: View) => {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Remembering the view is a convenience only.
    }
  };

  const loadSessions = useCallback(
    () =>
      api.listAllSessions().then(
        (next) => setSessions(next.filter((s) => !s.orchestratorId)),
        (e: Error) => setError(e.message),
      ),
    [],
  );

  const loadedLayout = useRef<WorkspaceLayout | null>(cachedWorkspaceLayout);
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
    const stop = serialPoll(
      () =>
        api.listAllSessions().then(
          (s) => {
            if (active) setSessions(s.filter((item) => !item.orchestratorId));
          },
          (e: Error) => {
            if (active) setError(e.message);
          },
        ),
      SESSIONS_POLL_MS,
    );
    return () => {
      active = false;
      stop();
    };
  }, [loadSessions]);

  useEffect(() => {
    if (view !== 'list') return;
    let active = true;
    const load = () => {
      return api.listAllRuns().then(
        (r) => {
          if (!active) return;
          setRuns(r.filter((item) => !item.orchestratorId));
          setNow(Date.now());
        },
        (e: Error) => active && setError(e.message),
      );
    };
    const stop = serialPoll(load, SESSIONS_POLL_MS);
    return () => {
      active = false;
      stop();
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

  /** Remove a task session and its log from the workspace after the user confirms disposal. */
  const disposeSession = async (id: number) => {
    try {
      await api.deleteSession(id);
      setSessions((prev) => prev?.filter((session) => session.id !== id) ?? prev);
      if (selectedWork === `session:${id}`) setSelectedWork(null);
      setLayout((prev) => {
        if (!prev || !prev.panes.includes(id)) return prev;
        const maxedPaneWasDeleted = prev.maximized !== null && prev.panes[prev.maximized] === id;
        return {
          ...prev,
          panes: prev.panes.map((sessionId) => (sessionId === id ? null : sessionId)),
          maximized: maxedPaneWasDeleted ? null : prev.maximized,
        };
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };

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
    <main
      className={`workspace${mobileNewOpen ? ' mobile-new-open' : ''}${mobileToolsOpen ? ' mobile-tools-open' : ''}`}
    >
      <div className="workspace-bar">
        <h1>Agents</h1>
        {/* Phones only (agents-toolbar.css shows it inside the tools menu): the phone tab bar has
            no Orchestrators entry, while desktop has it in the top bar (PM-71). */}
        <Link className="btn btn-sm workspace-orchestrator-link" to="/orchestrators">
          Orchestrators
        </Link>
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
                <ViewIcon view={v} />
                {v === 'panes' ? 'Panes' : 'List'}
              </button>
            ))}
          </div>
        </div>
        {/* Phones (PM-51): panes always stack there, so the layout is just how many. */}
        {view === 'panes' && (
          <div className="pane-count" role="radiogroup" aria-label="Number of panes">
            {PHONE_PRESETS.map(([count, preset]) => (
              <button
                key={preset}
                type="button"
                role="radio"
                aria-checked={info.panes === count}
                aria-label={`${count} ${count === 1 ? 'pane' : 'panes'}`}
                className={info.panes === count ? 'is-active' : undefined}
                onClick={() =>
                  update({ preset, panes: fitPanes(layout.panes, preset), maximized: null })
                }
              >
                {count}
              </button>
            ))}
          </div>
        )}
        <div className="workspace-mobile-actions">
          <button
            type="button"
            className="btn btn-sm"
            aria-expanded={mobileNewOpen}
            onClick={() => setMobileNewOpen(!mobileNewOpen)}
          >
            + New
          </button>
          <button
            type="button"
            className="btn btn-sm"
            aria-label="Workspace tools"
            aria-expanded={mobileToolsOpen}
            onClick={() => setMobileToolsOpen(!mobileToolsOpen)}
          >
            ⋯
          </button>
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
        {/* Plan usage sits in the toolbar's free middle in List view, costing the terminal no
            height (PM-50; out of the list header since PM-42). */}
        {view === 'list' && (
          <LimitsStrip
            inline
            providerIds={[
              ...new Set([...(sessions ?? []), ...(runs ?? [])].map((x) => x.providerId)),
            ]}
          />
        )}
        <NewSessionInline
          projects={projects}
          providers={providers}
          onCreated={(s) => {
            setMobileNewOpen(false);
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
          selected={selectedWork}
          onSelect={setSelectedWork}
          renderSession={(session, close, maximized, toggleMaximize, showContinue) => (
            // The same pane as the grid, docked under the list like VS Code's panel.
            <Pane
              key={session.id}
              index={0}
              inList
              showContinue={showContinue}
              fontSize={fontSize}
              onDragStart={() => undefined}
              onDragEnd={() => undefined}
              dropActive={false}
              onDragOver={() => undefined}
              onDrop={() => undefined}
              session={session}
              projectName={projectName.get(session.projectId) ?? `Project ${session.projectId}`}
              agentName={
                session.providerId === 'custom'
                  ? (session.command[0] ?? 'Custom command')
                  : (providers.find((p) => p.id === session.providerId)?.name ?? session.providerId)
              }
              maximized={maximized}
              onToggleMaximize={toggleMaximize}
              onClose={close}
              onChanged={(next) =>
                setSessions((prev) => prev?.map((x) => (x.id === next.id ? next : x)) ?? prev)
              }
              onDeleted={disposeSession}
              onError={setError}
            />
          )}
          onShowInPane={(id) => {
            update(placeSession(layout, id));
            setView('panes');
          }}
          onShowAllInPanes={(ids) => {
            let next: WorkspaceLayout = { ...layout, preset: '1', panes: [null], maximized: null };
            for (const id of ids.slice(0, 4)) next = placeSession(next, id);
            update(next);
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
          onOpenSession={(id) => navigate(`/workspace?open=${id}`)}
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
                onDeleted={disposeSession}
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
                onClose={
                  SHRINK[layout.preset] ? () => update(closeEmptyPane(layout, index)) : undefined
                }
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
  inList,
  showContinue = false,
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
  onDeleted,
  onError,
}: DropTargetProps & {
  index: number;
  inList?: boolean;
  showContinue?: boolean;
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
  onDeleted?: (id: number) => void;
  onError: (message: string) => void;
}) {
  const running = s.status === 'running';
  // Keystrokes batched per ~frame and sent strictly in order (fast typing and pastes stay intact).
  const inputQueue = useRef<TerminalInputQueue | null>(null);
  if (inputQueue.current === null)
    inputQueue.current = new TerminalInputQueue(
      (data) => api.sendSessionInput(s.id, data),
      (error) => onError(error.message),
    );
  const sendKeys = (data: string) => {
    inputQueue.current!.push(data);
  };
  const [line, setLine] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [cardNote, setCardNote] = useState<string | null>(null);
  // Phones: the session as a chat (its CLI's transcript) or the terminal.
  const sessionView = useSessionView(s);
  // Pastes into this pane's terminal like the keyboard would (image paths, PM-54).
  const pasteRef = useRef<((text: string) => void) | null>(null);
  const sendImage = (file: File) =>
    sendImageToSession(s.id, file, pasteRef.current).catch((e: Error) => onError(e.message));

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
        {!inList && (
          <span className="pane-index faint num" aria-hidden="true">
            {index + 1}
          </span>
        )}
        <span
          className={`status-dot${running ? ` is-${sessionActivity(s)}` : ''}`}
          style={{
            background: running
              ? 'var(--good)'
              : s.status === 'dead'
                ? 'var(--danger)'
                : 'var(--series-other)',
          }}
          role="img"
          aria-label={running ? ACTIVITY_LABEL[sessionActivity(s)] : `Ended (${s.status})`}
          title={running ? ACTIVITY_LABEL[sessionActivity(s)] : `Ended (${s.status})`}
        />
        <div className="pane-identity">
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
        </div>
        <SessionRestartStatus session={s} />
        {sessionView.available && (
          <ViewSwitch view={sessionView.view} onChange={sessionView.choose} />
        )}
        <span style={{ flex: 1 }} />
        <div className={`pane-controls${mobileActionsOpen ? ' is-open' : ''}`}>
          <button
            type="button"
            className="icon-btn pane-controls-toggle"
            aria-label="Session actions"
            aria-expanded={mobileActionsOpen}
            onClick={() => setMobileActionsOpen(!mobileActionsOpen)}
          >
            ⋯
          </button>
          <div className="pane-controls-buttons">
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
            {!inList && s.terminal === 'pty' && <SessionProgress session={s} />}
            {/* The chat's composer has its own image button. */}
            {running && s.terminal === 'pty' && sessionView.view !== 'chat' && (
              <SessionImageButton sessionId={s.id} pasteRef={pasteRef} onError={onError} />
            )}
            {showContinue && sessionView.view !== 'chat' && (
              <SessionContinue session={s} onError={onError} iconOnly />
            )}
            {running ? (
              <>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Restart ${s.name}`}
                  title="Restart session (stop, then start)"
                  disabled={restarting || (!!s.restartProgress && s.restartProgress !== 'failed')}
                  onClick={async () => {
                    setRestarting(true);
                    try {
                      await act(async () => {
                        return api.restartSession(s.id);
                      });
                    } finally {
                      setRestarting(false);
                    }
                  }}
                >
                  {restarting ? (
                    <span className="spinner" aria-hidden="true" />
                  ) : (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M20 7v5h-5M20 12a8 8 0 1 0-2 6M20 7l-2 2" />
                    </svg>
                  )}
                </button>
                <button
                  className="icon-btn"
                  title="Stop session"
                  disabled={restarting}
                  onClick={() => act(() => api.stopSession(s.id))}
                >
                  ■
                </button>
              </>
            ) : (
              <button
                className="icon-btn"
                title="Start session"
                onClick={() => act(() => api.startSession(s.id))}
              >
                ▶
              </button>
            )}
            {!running && s.cardId && !s.supervise && onDeleted && (
              <ConfirmDelete
                small
                label={`Dispose ${s.name}`}
                heading={`Dispose task session ${s.name}?`}
                message="This removes the ended session and its recorded output. The linked task stays on the board."
                confirmLabel="Dispose session"
                onConfirm={() => onDeleted(s.id)}
              />
            )}
          </div>
        </div>
        <button
          className="icon-btn"
          title={maximized ? 'Restore layout' : 'Maximise pane'}
          aria-pressed={maximized}
          onClick={onToggleMaximize}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path
              d={
                maximized
                  ? 'M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5'
                  : 'M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5'
              }
            />
          </svg>
        </button>
        <button
          className="icon-btn"
          title="Remove from layout (keeps the session running)"
          onClick={onClose}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </header>
      <div className="pane-body">
        {sessionView.view === 'chat' ? (
          <SessionChat key={s.id} session={s} onError={onError} pasteRef={pasteRef} />
        ) : (
          <Suspense fallback={<div className="terminal skeleton" style={{ height: '100%' }} />}>
            <TerminalView
              key={`${s.id}-${s.terminal}-${s.startedAt}`}
              historyBytes={s.logBytes}
              stopped={s.terminal === 'pty' && !running}
              height="100%"
              fontSize={fontSize}
              fetchOutput={(after) => api.sessionOutput(s.id, after)}
              streamUrl={(after) => api.sessionStreamUrl(s.id, after)}
              {...(s.terminal === 'pty'
                ? {
                    pasteRef,
                    onImage: sendImage,
                    // A stopped session only queues real typing, not the terminal's auto-replies.
                    onInput: (data: string) => {
                      if (running || !isTerminalReport(data)) sendKeys(data);
                    },
                    onResize: (cols: number, rows: number) => {
                      api.resizeSession(s.id, cols, rows).catch(() => undefined);
                    },
                  }
                : {})}
            />
          </Suspense>
        )}
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
  onClose,
}: DropTargetProps & {
  index: number;
  sessions: AgentSession[];
  loading: boolean;
  projectName: Map<number, string>;
  onPick: (sessionId: number) => void;
  /** Removes this pane (the grid shrinks by one); absent when it's the only pane. */
  onClose?: () => void;
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
      <div className="pane-empty-head">
        <h3>Show a session here</h3>
        {onClose && (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Close empty pane ${index + 1}`}
            title="Close this pane (one pane fewer)"
            onClick={onClose}
          >
            ✕
          </button>
        )}
      </div>
      {loading ? (
        <div className="skeleton" style={{ flex: 1 }} />
      ) : sorted.length === 0 ? (
        <p className="faint">
          No other sessions. Start one above, or open a card on a project&apos;s Board and choose
          “Work on it in a terminal”.
        </p>
      ) : (
        <>
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
  const [providerId, setProviderIdState] = useState(() => readLastAgent('claude'));
  const setProviderId = (id: string) => {
    setProviderIdState(id);
    saveLastAgent(id);
  };
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
          icon: <ProviderIcon id={p.id} size={14} />,
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

/** A list row's "put this session in a pane" button (answers to its keyboard shortcut). */
function ShowInPaneButton({ onClick }: { onClick: () => void }) {
  const keys = useShortcutProps('session.showInPane');
  const title = useShortcutTitle('session.showInPane', 'Put this session in a pane');
  return (
    <button
      type="button"
      className="btn btn-sm btn-icon session-show-pane"
      title={title}
      aria-label="Show in pane"
      {...keys}
      onClick={onClick}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M14 4v16M3 9h11" />
      </svg>
    </button>
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
        <Link to="/settings#keyboard-shortcuts">Shortcuts for the selected session…</Link>
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

const DOCK_KEY = 'pm.workspace.dockHeight';
const DOCK_MIN = 140;
/**
 * The docked terminal's height once dragged, or null for the default: the terminal takes the
 * space and the list keeps about three rows above it (PM-50), whatever the window height.
 */
function readDockHeight(): number | null {
  try {
    const v = Number(localStorage.getItem(DOCK_KEY));
    return Number.isFinite(v) && v >= DOCK_MIN ? v : null;
  } catch {
    return null;
  }
}

/** List view: every session and run across projects. Sessions open into a pane; runs expand. */
function WorkList({
  sessions,
  runs,
  now,
  usage,
  projectName,
  selected,
  onSelect,
  renderSession,
  onShowInPane,
  onShowAllInPanes,
  onSessionChanged,
  onSessionDeleted,
  onRunChanged,
  onRunDeleted,
  onOpenSession,
  onError,
}: {
  sessions: AgentSession[] | null;
  runs: AgentRun[] | null;
  now: number;
  usage: Record<number, AgentTokenUsage | null>;
  projectName: Map<number, string>;
  selected: WorkKey | null;
  onSelect: (key: WorkKey | null) => void;
  /** The docked panel for a selected session (its live terminal). */
  renderSession: (
    session: AgentSession,
    close: () => void,
    maximized: boolean,
    toggleMaximize: () => void,
    showContinue: boolean,
  ) => ReactNode;
  onShowInPane: (sessionId: number) => void;
  onShowAllInPanes: (sessionIds: number[]) => void;
  onSessionChanged: (s: AgentSession) => void;
  onSessionDeleted: (id: number) => void;
  onRunChanged: (r: AgentRun) => void;
  onRunDeleted: (id: number) => void;
  onOpenSession: (id: number) => void;
  onError: (message: string) => void;
}) {
  const [dockHeight, setDockHeight] = useState<number | null>(readDockHeight);
  const dockPanel = useRef<HTMLDivElement>(null);
  const [filters, setFilters] = useWorkFilters();
  const [sort, setSort] = useWorkSort();
  const [dockMax, setDockMax] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkButton = useRef<HTMLButtonElement>(null);
  const bulkMenu = useRef<HTMLDivElement>(null);
  const positionBulkMenu = useCallback(() => {
    const menu = bulkMenu.current;
    const button = bulkButton.current;
    if (!menu || !button) return;
    const rect = button.getBoundingClientRect();
    const height = menu.getBoundingClientRect().height || 220;
    const top =
      rect.bottom + 6 + height <= window.innerHeight - 8
        ? rect.bottom + 6
        : Math.max(8, rect.top - height - 6);
    menu.style.setProperty('--bulk-top', `${top}px`);
    menu.style.setProperty('--bulk-right', `${Math.max(8, window.innerWidth - rect.right)}px`);
  }, []);

  useEffect(() => {
    const onReposition = () => {
      if (bulkMenu.current?.matches?.(':popover-open')) {
        positionBulkMenu();
      }
    };
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [positionBulkMenu]);
  const container = useRef<HTMLElement>(null);
  const dockReady = !!sessions && !!runs;
  useEffect(() => {
    if (
      !dockReady ||
      !selected?.startsWith('session:') ||
      !window.matchMedia('(max-width: 768px)').matches
    ) {
      return;
    }
    // Bring the terminal into view after the mobile stack has laid out.
    const frame = requestAnimationFrame(() => {
      dockPanel.current?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, dockReady]);
  const resizeTo = (height: number) => {
    const total = container.current?.getBoundingClientRect().height ?? 800;
    const next = Math.round(Math.min(Math.max(height, DOCK_MIN), Math.max(DOCK_MIN, total - 140)));
    setDockHeight(next);
    try {
      localStorage.setItem(DOCK_KEY, String(next));
    } catch {
      // Remembering the height is a convenience only.
    }
  };
  /** Back to the default split (double-click on the edge). */
  const resetDock = () => {
    setDockHeight(null);
    try {
      localStorage.removeItem(DOCK_KEY);
    } catch {
      // As above.
    }
  };
  const currentDock = () =>
    dockHeight ?? Math.round(dockPanel.current?.getBoundingClientRect().height ?? 400);
  if (!sessions || !runs) return <div className="skeleton" style={{ flex: 1 }} />;
  const allItems = mergeWork(sessions, runs);
  const items = sortWork(applyWorkFilters(allItems, filters, now), sort, projectName);
  const visibleSessions = items.flatMap((w) => (w.kind === 'session' ? [w.item] : []));
  const liveSessions = visibleSessions.filter((s) => s.status === 'running');
  const stoppedSessions = visibleSessions.filter((s) => s.status !== 'running');
  const isEndedFilter =
    filters.status === 'ended' ||
    (Array.isArray(filters.status) && filters.status.length === 1 && filters.status[0] === 'ended');
  const includesEndedFilter = selectedFilters(filters.status, 'all').includes('ended');
  const statusFilters = selectedFilters(filters.status, 'all');
  const isIdleFilter = statusFilters.length === 1 && statusFilters[0] === 'idle';
  const includesAttentionFilter = selectedFilters(filters.status, 'all').includes('attention');
  const bulk = async (targets: AgentSession[], action: 'start' | 'stop' | 'restart' | 'delete') => {
    if (bulkBusy) return;
    setBulkBusy(true);
    const failures: string[] = [];
    try {
      for (const s of targets) {
        try {
          if (action === 'delete') {
            await api.deleteSession(s.id);
            onSessionDeleted(s.id);
          } else if (action === 'start') {
            onSessionChanged(await api.startSession(s.id));
          } else {
            onSessionChanged(
              await (action === 'restart' ? api.restartSession(s.id) : api.stopSession(s.id)),
            );
          }
        } catch (err) {
          failures.push(`${s.name}: ${(err as Error).message}`);
        }
      }
      if (failures.length) onError(failures.join('; '));
    } finally {
      setBulkBusy(false);
    }
  };
  // Filters affect the list, not the open terminal: typing can change Idle to Running.
  const run = runs.find((r) => `run:${r.id}` === selected) ?? null;
  const session = sessions.find((x) => `session:${x.id}` === selected) ?? null;
  const change = (fn: () => Promise<AgentSession>) =>
    fn().then(onSessionChanged, (e: Error) => onError(e.message));

  const actions = (w: WorkItem) => {
    if (w.kind !== 'session') return null;
    const s = w.item;
    return (
      <>
        {isIdleFilter && (
          <SessionContinue session={s} onError={onError} shortcut="session.continue" />
        )}
        <ShowInPaneButton onClick={() => onShowInPane(s.id)} />
        <SessionToggle
          session={s}
          shortcuts={{ restart: 'session.restart', toggle: 'session.toggle' }}
          onStart={() => change(() => api.startSession(s.id))}
          onStop={() => change(() => api.stopSession(s.id))}
          onRestart={async () => {
            try {
              onSessionChanged(await api.restartSession(s.id));
            } catch (err) {
              onError((err as Error).message);
            }
          }}
        />
        <ConfirmDelete
          label={`Delete session "${s.name}"`}
          heading={`Delete session "${s.name}"?`}
          message="Stops the process if it's running and deletes its log. This can't be undone."
          shortcut="session.delete"
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
    <section
      ref={container}
      className={`panel workspace-list${session || run ? ' has-dock' : ''}${dockMax && session ? ' is-dock-max' : ''}`}
      aria-label="All agent work"
    >
      {/* No title row: the page is already "Agents". Filters and the count share one row, so the
          list and its terminal get the height (PM-50). */}
      <div className="work-list-top">
        {visibleSessions.length > 0 && (
          <div className="work-bulk">
            <button
              type="button"
              className="btn btn-sm"
              popoverTarget="workspace-bulk-actions"
              popoverTargetAction="toggle"
              ref={bulkButton}
              onClick={positionBulkMenu}
              aria-label={`Actions for ${visibleSessions.length} filtered sessions`}
            >
              {bulkBusy ? (
                'Working…'
              ) : (
                <>
                  Actions<span className="phone-hide"> ({visibleSessions.length})</span>
                </>
              )}
            </button>
            <div
              ref={bulkMenu}
              id="workspace-bulk-actions"
              popover="auto"
              className="work-bulk-menu"
              onToggle={positionBulkMenu}
            >
              <span className="faint">
                {visibleSessions.length} sessions matching current filters
              </span>
              <button
                className="btn btn-sm"
                disabled={bulkBusy}
                onClick={() => onShowAllInPanes(visibleSessions.map((s) => s.id))}
              >
                Show in panes ({visibleSessions.length > 4 ? 'first 4' : visibleSessions.length})
              </button>
              <BatchSessionMessage sessions={visibleSessions} />
              <BatchAttentionActions
                sessions={visibleSessions}
                isAttentionFilter={includesAttentionFilter}
                projectName={projectName}
              />
              {includesEndedFilter && stoppedSessions.length > 0 && (
                <button
                  className="btn btn-sm"
                  disabled={bulkBusy}
                  onClick={() => void bulk(stoppedSessions, 'start')}
                >
                  {isEndedFilter
                    ? `Start all sessions (${stoppedSessions.length})`
                    : `Start stopped (${stoppedSessions.length})`}
                </button>
              )}
              <button
                className="btn btn-sm"
                disabled={bulkBusy || !liveSessions.length}
                onClick={() => void bulk(liveSessions, 'restart')}
              >
                Restart running ({liveSessions.length})
              </button>
              <button
                className="btn btn-sm"
                disabled={bulkBusy || !liveSessions.length}
                onClick={() => void bulk(liveSessions, 'stop')}
              >
                Stop running ({liveSessions.length})
              </button>
              {!bulkBusy && (
                <ConfirmDelete
                  label="Delete visible sessions"
                  text={`Delete (${visibleSessions.length})`}
                  heading={`Delete ${visibleSessions.length} filtered sessions?`}
                  message="Stops these sessions and permanently deletes their logs. Only sessions matching the current filters are affected."
                  onConfirm={() => bulk(visibleSessions, 'delete')}
                />
              )}
            </div>
          </div>
        )}
        {allItems.length > 0 && (
          <WorkFilters
            items={allItems}
            filters={filters}
            onChange={setFilters}
            now={now}
            projectNames={projectName}
          />
        )}
        {allItems.length > 0 && <WorkSorter sort={sort} onChange={setSort} />}
        <span className="meta">
          {sessions.length} session{sessions.length === 1 ? '' : 's'} · {runs.length} run
          {runs.length === 1 ? '' : 's'}
        </span>
      </div>
      <div
        className={`work-list-scroll${session || run ? ' is-docked' : ''}${
          session && dockHeight === null ? ' is-auto' : ''
        }`}
      >
        {allItems.length === 0 ? (
          <p className="faint" style={{ margin: 0 }}>
            Nothing yet. Start a session from the toolbar, or hand a card to an agent from a board.
          </p>
        ) : items.length === 0 ? (
          <p className="faint" style={{ margin: 0 }}>
            No agent work matches these filters ·{' '}
            <button type="button" className="link-button" onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </button>
          </p>
        ) : (
          <AgentWorkList
            items={items}
            selected={selected}
            onSelect={(key: WorkKey) => onSelect(key === selected ? null : key)}
            onNavigate={(key: WorkKey) => onSelect(key)}
            now={now}
            tokens={usage}
            projectNames={projectName}
            actions={actions}
            onRename={(w, name) =>
              w.kind === 'session'
                ? change(() => api.patchSession(w.item.id, { name }))
                : api
                    .renameRun(w.item.id, name)
                    .then(onRunChanged, (e: Error) => onError(e.message))
            }
          />
        )}
      </div>
      {session && (
        <>
          {/* Drag (or arrow keys) to resize the docked terminal, like VS Code's panel edge. */}
          {!dockMax && (
            <div
              className="work-resizer"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize terminal panel"
              aria-valuenow={dockHeight ?? undefined}
              tabIndex={0}
              title="Drag to resize · double-click to reset"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                const bottom = container.current?.getBoundingClientRect().bottom ?? 0;
                const onMove = (ev: PointerEvent) => resizeTo(bottom - ev.clientY - 12);
                const onUp = () => {
                  window.removeEventListener('pointermove', onMove);
                  window.removeEventListener('pointerup', onUp);
                };
                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
              }}
              onDoubleClick={resetDock}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp') resizeTo(currentDock() + 24);
                else if (e.key === 'ArrowDown') resizeTo(currentDock() - 24);
                else return;
                e.preventDefault();
              }}
            />
          )}
          <div
            ref={dockPanel}
            className={`work-panel${dockHeight === null ? ' is-auto' : ''}`}
            aria-label={`Terminal: ${session.name}`}
            style={dockMax || dockHeight === null ? undefined : { height: dockHeight }}
          >
            {renderSession(
              session,
              () => {
                setDockMax(false);
                onSelect(null);
              },
              dockMax,
              () => setDockMax((v) => !v),
              session.status === 'running',
            )}
          </div>
        </>
      )}
      {run && (
        <div className="work-panel work-panel-run">
          <RunCard
            run={run}
            now={now}
            hideHeader
            onOpenSession={onOpenSession}
            onChanged={onRunChanged}
            onDeleted={(id) => {
              onRunDeleted(id);
              onSelect(null);
            }}
          />
        </div>
      )}
    </section>
  );
}

/** Panes: a 2x2 grid of terminals. List: rows. */
function ViewIcon({ view }: { view: View }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
      {view === 'panes' ? (
        <path
          d="M2 2.5h5v5H2zM9 2.5h5v5H9zM2 9.5h5v5H2zM9 9.5h5v5H9z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M2 3.5h12M2 8h12M2 12.5h12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
