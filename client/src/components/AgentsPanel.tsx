import './project-agents.css';
import './project-terminal.css';
import { Suspense, lazy, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ProviderIcon, InfoIcon } from './icons';
import type {
  AgentProviderStatus,
  AgentRun,
  AgentSession,
  AgentTokenUsage,
} from '../../../shared/types';
import { Link, useNavigate } from 'react-router';
import { api } from '../api';
import { Dropdown } from './Dropdown';
import { InlineRename } from './InlineRename';
import { readLastAgent, saveLastAgent } from '../lastAgent';
import { isTerminalReport } from '../../../shared/terminalReports';
import { AgentWorkList, mergeWork, workKey, type WorkItem, type WorkKey } from './AgentWorkList';
import { RunCard } from './RunCard';
import { ConfirmDelete } from './ConfirmDelete';
import { SessionToggle } from './SessionToggle';
import { LimitsStrip } from './LimitsStrip';
import { sendImageToSession } from '../sessionImages';
import { SessionPaneActions } from './SessionPaneActions';
import { SessionRestartStatus } from './SessionProgress';
import { SessionChat, ViewSwitch, useSessionView } from './SessionChat';
import { RecentCache } from '../lib/recentCache';
import { TerminalInputQueue } from '../lib/terminalInputQueue';
import { ACTIVITY_LABEL, sessionActivity } from '../sessionActivity';

// Preload TerminalView chunk as soon as agents panel loads so it is ready when terminal renders.
const terminalViewPromise = import('./TerminalView');
const TerminalView = lazy(() => terminalViewPromise.then((m) => ({ default: m.TerminalView })));

// Tab memory, same pattern as the board: revisits render instantly from the
// module cache and refresh in the background. The project page keys the panel
// by project and only polls while its tab is visible (no wasteful background
// polling from a hidden tab).
const sessionsCache = new RecentCache<number, AgentSession[]>(8);
const runsCache = new RecentCache<number, AgentRun[]>(8);

const DOCK_KEY = 'pm.projectAgents.dockHeight';
const DOCK_MIN = 140;

function readDockHeight(): number | null {
  try {
    const v = Number(localStorage.getItem(DOCK_KEY));
    return Number.isFinite(v) && v >= DOCK_MIN ? v : null;
  } catch {
    return null;
  }
}

/** Per-project agent HQ: providers, persistent terminal sessions, and card runs. */
export function AgentsPanel({
  projectId,
  projectName,
  visible,
}: {
  projectId: number;
  /** Shown beside the open session, so the CLI says which project it is in (PM-131). */
  projectName?: string;
  visible: boolean;
}) {
  const navigate = useNavigate();
  const [providers, setProviders] = useState<AgentProviderStatus[] | null>(null);
  const [sessions, setSessions] = useState<AgentSession[] | null>(
    () => sessionsCache.get(projectId)?.filter((s) => !s.orchestratorId) ?? null,
  );
  const [runs, setRuns] = useState<AgentRun[] | null>(
    () => runsCache.get(projectId)?.filter((r) => !r.orchestratorId) ?? null,
  );
  const [selected, setSelectedState] = useState<WorkKey | null>(() => {
    const stored = readSelection(projectId);
    return stored === 'closed' ? null : stored;
  });
  // The selection is remembered per project (switching projects, reloads, restarts).
  const setSelected = useCallback(
    (next: WorkKey | null | ((prev: WorkKey | null) => WorkKey | null)) =>
      setSelectedState((prev) => {
        const value = typeof next === 'function' ? next(prev) : next;
        saveSelection(projectId, value);
        return value;
      }),
    [projectId],
  );
  const [dockHeight, setDockHeight] = useState<number | null>(readDockHeight);
  const [dockMax, setDockMax] = useState(false);
  const dockContainer = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const resizeTo = (height: number) => {
    const minTerminal = DOCK_MIN;
    const maxTerminal = Math.max(
      minTerminal,
      (window.visualViewport?.height ?? window.innerHeight) - 140,
    );
    const next = Math.round(Math.min(Math.max(height, minTerminal), maxTerminal));
    setDockHeight(next);
    try {
      localStorage.setItem(DOCK_KEY, String(next));
    } catch {
      // Remembering the height is a convenience only.
    }
  };

  const resetDock = () => {
    setDockHeight(null);
    try {
      localStorage.removeItem(DOCK_KEY);
    } catch {
      // As above.
    }
  };

  const currentDock = () =>
    dockHeight ?? Math.round(dockContainer.current?.getBoundingClientRect().height ?? 360);

  useEffect(() => {
    if (!selected?.startsWith('session:') || !window.matchMedia('(max-width: 768px)').matches) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      dockContainer.current?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected]);

  // Desktop (PM-105): the tab fills the space down to the window's bottom edge, so the docked
  // terminal sits on that edge even when the list above is short (CSS: --project-fill).
  const hasTerminal = Boolean(selected);
  useEffect(() => {
    const root = rootRef.current;
    const main = root?.closest<HTMLElement>('.app-main');
    if (!root || !main || !hasTerminal) return;
    const measure = () => {
      let below = 8; // The dock's gap above the window edge (sticky bottom: 8px), plus the
      // padding and margins of the wrappers between the tab and the scroller.
      for (let el = root.parentElement; el && el !== main; el = el.parentElement) {
        const style = getComputedStyle(el);
        below += (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.marginBottom) || 0);
      }
      const top =
        root.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      root.style.setProperty('--project-fill', `${Math.max(0, main.clientHeight - top - below)}px`);
    };
    measure();
    // The window, and anything above the tab changing height (e.g. an opened details panel).
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    if (main.firstElementChild) observer.observe(main.firstElementChild);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--project-fill');
    };
  }, [hasTerminal]);

  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [input, setInput] = useState('');
  const [queuedNote, setQueuedNote] = useState(false);
  const [usage, setUsage] = useState<Record<number, AgentTokenUsage | null>>({});

  // Only sets state in promise callbacks, so effects may call it directly.
  const load = useCallback(
    () =>
      Promise.all([api.listSessions(projectId), api.listRuns(projectId)]).then(
        ([allSessions, allRuns]) => {
          const r = allRuns.filter((item) => !item.orchestratorId);
          const s = allSessions.filter((item) => !item.orchestratorId);
          sessionsCache.set(projectId, s);
          // Token counts come from Claude's own transcripts; other CLIs report none.
          const claude = s.filter((x) => x.providerId === 'claude').map((x) => x.id);
          if (claude.length > 0) {
            api.sessionUsage(claude).then(setUsage, () => undefined);
          }
          runsCache.set(projectId, r);
          setSessions(s);
          setRuns(r);
          setNow(Date.now());
          setError(null);
          setSelected((prev) => {
            const items = mergeWork(s, r);
            const exists = (key: WorkKey | null) => !!key && items.some((w) => workKey(w) === key);
            // This project's remembered choice first (prev may belong to the last project).
            const stored = readSelection(projectId);
            if (stored === 'closed') return null;
            if (exists(stored)) return stored;
            if (exists(prev)) return prev;
            return items[0] ? workKey(items[0]) : null;
          });
        },
        (e: Error) => setError(e.message),
      ),
    [projectId, setSelected],
  );

  useEffect(() => {
    api
      .listProviders()
      .then(setProviders)
      .catch((e: Error) => setError(e.message));
    load();
  }, [load]);

  // Poll fast while anything is alive, slow otherwise (KDP populated-pane rule:
  // refreshes never blank what is on screen). A hidden tab never polls at all.
  const alive =
    sessions?.some((s) => s.status === 'running') ??
    runs?.some((r) => r.status === 'running' || r.status === 'queued') ??
    false;
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(load, alive ? 2000 : 10000);
    return () => clearTimeout(timer);
  }, [visible, alive, sessions, runs, load]);

  const active = sessions?.find((s) => `session:${s.id}` === selected) ?? null;
  // Phones: the open session as a chat (its CLI's transcript) or the terminal.
  const sessionView = useSessionView(active);
  const [actionsOpen, setActionsOpen] = useState(false);
  const activeRun = runs?.find((r) => `run:${r.id}` === selected) ?? null;
  const work = sessions && runs ? mergeWork(sessions, runs) : null;
  const available = providers?.filter((p) => p.available).length ?? 0;

  async function changeSession(fn: () => Promise<AgentSession>) {
    try {
      const next = await fn();
      setSessions((prev) => prev?.map((x) => (x.id === next.id ? next : x)) ?? prev);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function sessionActions(w: WorkItem) {
    if (w.kind !== 'session') return null;
    const s = w.item;
    return (
      <>
        <Link
          className="btn btn-sm"
          to={`/workspace?open=${s.id}`}
          title="Show this session in the multi-pane Agents workspace"
          aria-label="Open in workspace"
        >
          Open<span className="phone-hide">in workspace</span>
        </Link>
        <SessionToggle
          session={s}
          onStart={() => changeSession(() => api.startSession(s.id))}
          onStop={() => changeSession(() => api.stopSession(s.id))}
          onRestart={() =>
            changeSession(async () => {
              return api.restartSession(s.id);
            })
          }
        />
        <ConfirmDelete
          label={`Delete session "${s.name}"`}
          heading={`Delete session "${s.name}"?`}
          message="Stops the process if it's running and deletes its log. This can't be undone."
          onConfirm={async () => {
            try {
              await api.deleteSession(s.id);
              setSessions((prev) => prev?.filter((x) => x.id !== s.id) ?? prev);
              if (selected === `session:${s.id}`) {
                setSelected(null);
              }
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      </>
    );
  }

  async function sendInput(event: FormEvent) {
    event.preventDefault();
    if (!active || !input) return;
    try {
      const { queued } = await api.sendSessionInput(active.id, input + '\n');
      setQueuedNote(queued);
      setInput('');
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Keystrokes from interactive (PTY) terminals: batched per ~frame and sent strictly in order,
  // so fast typing or pastes arrive intact.
  // Pastes into the shown terminal like the keyboard would (image paths, PM-54).
  const pasteRef = useRef<((text: string) => void) | null>(null);
  const keyQueues = useRef(new Map<number, TerminalInputQueue>());
  function sendKeys(sessionId: number, data: string) {
    let queue = keyQueues.current.get(sessionId);
    if (!queue) {
      queue = new TerminalInputQueue(
        async (chunk) => {
          const { queued } = await api.sendSessionInput(sessionId, chunk);
          if (queued) setQueuedNote(true);
        },
        (error) => setError(error.message),
      );
      keyQueues.current.set(sessionId, queue);
    }
    queue.push(data);
  }
  function upsertRun(next: AgentRun) {
    setRuns((prev) => {
      if (!prev) return [next];
      if (prev.some((r) => r.id === next.id)) {
        return prev.map((r) => (r.id === next.id ? next : r));
      }
      return [next, ...prev];
    });
  }

  return (
    <div
      ref={rootRef}
      className={`agents project-agents${active || activeRun ? ' has-terminal' : ''}`}
    >
      {error && <div className="error-banner">{error}</div>}

      <section className="panel agents-start" aria-label="Start a session">
        <NewSessionForm
          projectId={projectId}
          providers={providers ?? []}
          onCreated={(s) => {
            setSessions((prev) => [...(prev ?? []), s]);
            setSelected(`session:${s.id}`);
          }}
          onError={setError}
        />
        <details className="providers-details">
          <summary>
            Agents on this machine{' '}
            <span className="faint">
              · {providers ? `${available} of ${providers.length} available` : 'checking…'}
            </span>
          </summary>
          {providers === null ? (
            <div className="skeleton" style={{ height: 40 }} />
          ) : (
            <ul className="list provider-list">
              {providers.map((p) => (
                <li key={p.id}>
                  <span
                    className={`status-dot ${p.available ? 'green' : ''}`}
                    role="img"
                    aria-label={p.available ? 'Available' : 'Not available'}
                  />
                  <span style={{ minWidth: 0 }}>
                    <b>{p.name}</b>{' '}
                    <span className="faint" style={{ fontSize: 12 }}>
                      {p.description}
                    </span>
                    {!p.available && p.installUrl && (
                      <>
                        {' '}
                        <a href={p.installUrl} target="_blank" rel="noreferrer">
                          install
                        </a>
                      </>
                    )}
                  </span>
                  <span style={{ flex: 1 }} />
                  {!p.available && p.binary && (
                    <span className="badge" title={p.unavailableReason}>
                      unavailable
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </details>
      </section>

      {/* Plan usage in its own slim section under Agent work (PM-42). */}
      {work && <LimitsStrip providerIds={[...new Set(work.map((w) => w.item.providerId))]} />}

      <section className="panel workspace-list project-work-panel" aria-label="Agent work">
        <div className="panel-header">
          <div className="panel-title-row">
            <h2>
              Sessions and runs <span className="badge">{work?.length ?? 0}</span>
            </h2>
            <SessionsInfoButton />
          </div>
          <span
            className="meta"
            title="Terminal: an interactive session you type into; it keeps running until you stop it. One-shot: a card dispatch that runs once, then waits for you to accept or reject its changes."
          >
            Terminals keep running until stopped · one-shot runs wait for your review
          </span>
        </div>

        <div className="work-list-scroll">
          {work === null ? (
            <div className="skeleton" style={{ height: 120 }} />
          ) : work.length === 0 ? (
            <p className="faint" style={{ margin: 0 }}>
              Nothing yet. Start a terminal session above, or open a card on the Board and hand it
              to an agent.
            </p>
          ) : (
            <AgentWorkList
              items={work}
              selected={selected}
              onSelect={(key: WorkKey) => setSelected((prev) => (key === prev ? null : key))}
              onNavigate={(key: WorkKey) => setSelected(key)}
              now={now}
              tokens={usage}
              actions={sessionActions}
              onRename={(w, name) =>
                w.kind === 'session'
                  ? changeSession(() => api.patchSession(w.item.id, { name }))
                  : api
                      .renameRun(w.item.id, name)
                      .then(upsertRun, (e: Error) => setError(e.message))
              }
            />
          )}
        </div>
      </section>

      {(active || activeRun) && (
        <div
          ref={dockContainer}
          className={`project-cli-dock${dockMax ? ' is-dock-max' : ''}`}
          aria-label={active ? `Terminal: ${active.name}` : `Run: ${activeRun?.name ?? 'Review'}`}
          style={
            dockMax
              ? undefined
              : ({
                  height: dockHeight ?? 360,
                  '--project-dock-height': `${dockHeight ?? 360}px`,
                } as import('react').CSSProperties)
          }
        >
          {active && (
            <>
              {!dockMax && (
                <div
                  className="work-resizer project-dock-resizer"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize terminal panel"
                  aria-valuenow={dockHeight ?? 360}
                  tabIndex={0}
                  title="Drag to resize · double-click to reset"
                  onPointerDown={(e) => {
                    try {
                      e.currentTarget.setPointerCapture(e.pointerId);
                    } catch {
                      // Pointer capture unsupported or denied.
                    }
                    const resizerEl = e.currentTarget;
                    const startY = e.clientY;
                    const startHeight = currentDock();
                    const onMove = (ev: PointerEvent) => {
                      const delta = startY - ev.clientY;
                      resizeTo(startHeight + delta);
                    };
                    const onUp = (ev: PointerEvent) => {
                      try {
                        if (resizerEl.hasPointerCapture(ev.pointerId)) {
                          resizerEl.releasePointerCapture(ev.pointerId);
                        }
                      } catch {
                        // Already released.
                      }
                      window.removeEventListener('pointermove', onMove);
                      window.removeEventListener('pointerup', onUp);
                      window.removeEventListener('pointercancel', onUp);
                    };
                    window.addEventListener('pointermove', onMove);
                    window.addEventListener('pointerup', onUp);
                    window.addEventListener('pointercancel', onUp);
                  }}
                  onDoubleClick={resetDock}
                  onKeyDown={(e) => {
                    const cur = currentDock();
                    if (e.key === 'ArrowUp') resizeTo(cur + 24);
                    else if (e.key === 'ArrowDown') resizeTo(cur - 24);
                    else return;
                    e.preventDefault();
                  }}
                />
              )}
              <section className="pane">
                <header
                  className="pane-head project-terminal-head"
                  onDoubleClick={() => setDockMax((v) => !v)}
                  title="Double-click to maximise"
                >
                  <span
                    className={`status-dot${active.status === 'running' ? ` is-${sessionActivity(active)}` : ''}`}
                    style={{
                      background:
                        active.status === 'running'
                          ? 'var(--good)'
                          : active.status === 'dead'
                            ? 'var(--danger)'
                            : 'var(--series-other)',
                    }}
                    role="img"
                    aria-label={
                      active.status === 'running'
                        ? ACTIVITY_LABEL[sessionActivity(active)]
                        : `Ended (${active.status})`
                    }
                    title={
                      active.status === 'running'
                        ? ACTIVITY_LABEL[sessionActivity(active)]
                        : `Ended (${active.status})`
                    }
                  />
                  <div className="pane-identity">
                    <InlineRename
                      value={active.name}
                      label="session"
                      onSave={(name) =>
                        api.patchSession(active.id, { name }).then(
                          (next) =>
                            setSessions(
                              (prev) => prev?.map((x) => (x.id === next.id ? next : x)) ?? prev,
                            ),
                          (e: Error) => setError(e.message),
                        )
                      }
                    />
                    {/* Which project this CLI belongs to, also on phones and in full screen
                        where the page title is out of sight (PM-131). */}
                    {projectName && (
                      <span className="project-terminal-project" title={projectName}>
                        {projectName}
                      </span>
                    )}
                    <span className="pane-meta faint">
                      <span className="truncate mono" title={active.cwd}>
                        {active.cwd}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {active.status}
                        {active.pid ? ` · pid ${active.pid}` : ''}
                      </span>
                    </span>
                  </div>
                  <SessionRestartStatus session={active} />
                  {sessionView.available && (
                    <ViewSwitch view={sessionView.view} onChange={sessionView.choose} />
                  )}
                  <span className="project-terminal-spacer" style={{ flex: 1 }} />
                  {/* Phones: the title gets the room; the actions open from ⋯ in a row below. */}
                  <button
                    type="button"
                    className="icon-btn project-actions-toggle"
                    aria-label="Session actions"
                    aria-expanded={actionsOpen}
                    onClick={() => setActionsOpen((open) => !open)}
                  >
                    ⋯
                  </button>
                  <div className={`project-terminal-actions${actionsOpen ? ' is-open' : ''}`}>
                    {/* The same actions as the global Agents workspace (Continue, → Review…). */}
                    <SessionPaneActions
                      session={active}
                      view={sessionView.view}
                      pasteRef={pasteRef}
                      onChanged={(next) =>
                        setSessions(
                          (prev) => prev?.map((x) => (x.id === next.id ? next : x)) ?? prev,
                        )
                      }
                      onError={setError}
                    />
                  </div>
                  {/* Always visible: on phones it is the way back from full screen. */}
                  <button
                    type="button"
                    className="icon-btn project-terminal-max"
                    aria-label={dockMax ? 'Restore layout' : 'Full screen'}
                    title={dockMax ? 'Restore layout' : 'Maximise pane'}
                    aria-pressed={dockMax}
                    onClick={() => setDockMax((v) => !v)}
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
                          dockMax
                            ? 'M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5'
                            : 'M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5'
                        }
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="icon-btn project-terminal-close"
                    title="Close terminal view (keeps the session running)"
                    aria-label="Close terminal view"
                    onClick={() => {
                      setDockMax(false);
                      setSelected(null);
                    }}
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
                    <SessionChat
                      key={active.id}
                      session={active}
                      onError={setError}
                      pasteRef={pasteRef}
                    />
                  ) : (
                    <Suspense
                      fallback={<div className="terminal skeleton" style={{ height: '100%' }} />}
                    >
                      <TerminalView
                        key={`${active.id}-${active.terminal}-${active.startedAt}`}
                        historyBytes={active.logBytes}
                        stopped={active.terminal === 'pty' && active.status !== 'running'}
                        height="100%"
                        fetchOutput={(after) => api.sessionOutput(active.id, after)}
                        streamUrl={(after) => api.sessionStreamUrl(active.id, after)}
                        paused={!visible}
                        {...(active.terminal === 'pty'
                          ? {
                              pasteRef,
                              onImage: (file: File) =>
                                sendImageToSession(active.id, file, pasteRef.current).catch(
                                  (e: Error) => setError(e.message),
                                ),
                              // A stopped session only queues real typing, not the terminal's auto-replies.
                              onInput: (data: string) => {
                                if (active.status === 'running' || !isTerminalReport(data)) {
                                  sendKeys(active.id, data);
                                }
                              },
                              onResize: (cols: number, rows: number) => {
                                api.resizeSession(active.id, cols, rows).catch(() => undefined);
                              },
                            }
                          : {})}
                      />
                    </Suspense>
                  )}
                </div>
                {active.terminal !== 'pty' && (
                  <form className="pane-input" onSubmit={sendInput}>
                    <input
                      className="input mono"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      placeholder={
                        active.status === 'running'
                          ? 'Type input for the session… (Enter to send)'
                          : 'Session is down — input will queue for relaunch'
                      }
                      spellCheck={false}
                      autoComplete="off"
                      aria-label="Session input"
                    />
                    <button
                      type="button"
                      className="btn"
                      title="Send Ctrl+C (interrupt)"
                      onClick={async () => {
                        try {
                          const { queued } = await api.sendSessionInput(active.id, '\x03');
                          setQueuedNote(queued);
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      ^C
                    </button>
                    <button type="submit" className="btn btn-primary" disabled={!input}>
                      Send
                    </button>
                  </form>
                )}
                {queuedNote && (
                  <div className="notice" role="status" style={{ margin: '6px 0 0' }}>
                    <span>Queued — it flushes into the session when the process is back.</span>
                    <button className="btn btn-sm" onClick={() => setQueuedNote(false)}>
                      Dismiss
                    </button>
                  </div>
                )}
              </section>
            </>
          )}

          {activeRun && (
            <section className="pane pane-run">
              <header className="pane-head" style={{ marginBottom: 8 }}>
                <span style={{ fontWeight: 600 }}>Review: {activeRun.name}</span>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="icon-btn"
                  title="Close run view"
                  aria-label="Close run view"
                  onClick={() => setSelected(null)}
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
              <RunCard
                run={activeRun}
                now={now}
                paused={!visible}
                onOpenSession={(id) => navigate(`/workspace?open=${id}`)}
                onChanged={upsertRun}
                onDeleted={(id) => {
                  setRuns((prev) => prev?.filter((x) => x.id !== id) ?? prev);
                  setSelected(null);
                }}
              />
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function SessionsInfoButton() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button
        type="button"
        className="icon-btn info-btn"
        title="About sessions and runs"
        aria-label="About sessions and runs"
        aria-haspopup="dialog"
        onClick={() => dialogRef.current?.showModal()}
      >
        <InfoIcon size={14} />
      </button>
      <dialog
        ref={dialogRef}
        className="confirm-dialog sessions-info-dialog"
        aria-label="About sessions and runs"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            const bounds = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < bounds.left ||
              event.clientX > bounds.right ||
              event.clientY < bounds.top ||
              event.clientY > bounds.bottom
            )
              event.currentTarget.close();
          }
        }}
      >
        <div className="dialog-body">
          <h2>Sessions and runs</h2>
          <p>
            Sessions run on this machine as your user, rooted in the project folder by default.
            Access is limited to this machine, devices you pair through LAN access, and, if you turn
            it on, Remote access from anywhere (through your Cloudflare Tunnel, with Cloudflare
            Access sign-in and an authenticator code). Both are off by default and set up in
            Settings. Sessions keep running when ProjectManager restarts, relaunch after crashes and
            reboots, and are only removed when you stop or delete them; input typed while one is
            down waits in a durable queue.
          </p>
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn" onClick={() => dialogRef.current?.close()}>
            Close
          </button>
        </div>
      </dialog>
    </>
  );
}

function NewSessionForm({
  projectId,
  providers,
  onCreated,
  onError,
}: {
  projectId: number;
  providers: AgentProviderStatus[];
  onCreated: (s: AgentSession) => void;
  onError: (message: string) => void;
}) {
  const [providerId, setProviderIdState] = useState(() => readLastAgent('shell'));
  const setProviderId = (id: string) => {
    setProviderIdState(id);
    saveLastAgent(id);
  };
  const [name, setName] = useState('');
  const [binary, setBinary] = useState('');
  const [args, setArgs] = useState('');
  const [busy, setBusy] = useState(false);
  const provider = providers.find((p) => p.id === providerId);
  const needsCommand = providerId === 'custom';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const input: Parameters<typeof api.createSession>[1] =
        providerId === 'custom'
          ? {
              providerId: 'custom',
              command: [binary.trim(), ...args.split(/\s+/).filter(Boolean)],
              ...(name.trim() ? { name: name.trim() } : {}),
            }
          : {
              providerId,
              ...(name.trim() ? { name: name.trim() } : {}),
            };
      onCreated(await api.createSession(projectId, input));
      setName('');
      setBinary('');
      setArgs('');
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="session-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="agent-provider">New session</label>
        <div className="session-form-row">
          <Dropdown
            id="agent-provider"
            label="Agent"
            value={providerId}
            options={providers.map((p) => ({
              value: p.id,
              icon: <ProviderIcon id={p.id} size={14} />,
              label: p.name,
              disabled: !p.available,
              ...(p.available ? {} : { hint: 'not on PATH', title: `${p.name} isn’t on PATH` }),
            }))}
            onChange={setProviderId}
          />
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional)"
            maxLength={80}
            aria-label="Session name"
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || (needsCommand && !binary.trim())}
          >
            Start
          </button>
        </div>
      </div>
      {needsCommand && (
        <div className="session-form-row">
          <input
            className="input mono"
            value={binary}
            onChange={(e) => setBinary(e.target.value)}
            placeholder="Executable (on PATH or absolute path)"
            spellCheck={false}
            autoComplete="off"
            aria-label="Executable"
          />
          <input
            className="input mono"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            placeholder="Arguments, space separated"
            spellCheck={false}
            autoComplete="off"
            aria-label="Arguments"
          />
        </div>
      )}
      {provider && !provider.available && provider.installUrl && (
        <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
          {provider.name} isn’t on PATH.{' '}
          <a href={provider.installUrl} target="_blank" rel="noreferrer">
            Install it
          </a>{' '}
          to use this provider.
        </p>
      )}
    </form>
  );
}

const SELECTION_KEY = 'pm.agents.selected';

/** The session or run last selected on this project's Agents tab (null if none, 'closed' if explicitly closed). */
function readSelection(projectId: number): WorkKey | null | 'closed' {
  try {
    const all = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? '{}') as Record<string, string>;
    const value = all[projectId];
    if (value === 'closed') return 'closed';
    return value && /^(session|run):\d+$/.test(value) ? (value as WorkKey) : null;
  } catch {
    return null;
  }
}

function saveSelection(projectId: number, key: WorkKey | null): void {
  try {
    const all = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? '{}') as Record<string, string>;
    if (key) all[projectId] = key;
    else all[projectId] = 'closed';
    localStorage.setItem(SELECTION_KEY, JSON.stringify(all));
  } catch {
    // Remembering the selection is a convenience only.
  }
}
