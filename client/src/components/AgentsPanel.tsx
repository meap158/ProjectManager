import { Suspense, lazy, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  AgentProviderStatus,
  AgentRun,
  AgentSession,
  AgentTokenUsage,
} from '../../../shared/types';
import { Link } from 'react-router';
import { api } from '../api';
import { Dropdown } from './Dropdown';
import { InlineRename } from './InlineRename';
import { isTerminalReport } from '../terminalReports';
import { AgentWorkList, mergeWork, workKey, type WorkItem, type WorkKey } from './AgentWorkList';
import { RunCard } from './RunCard';
import { ConfirmDelete } from './ConfirmDelete';

// xterm is heavy: it loads only when a terminal actually renders.
const TerminalView = lazy(() =>
  import('./TerminalView').then((m) => ({ default: m.TerminalView })),
);

// Tab memory, same pattern as the board: revisits render instantly from the
// module cache and refresh in the background. The project page keys the panel
// by project and only polls while its tab is visible (no wasteful background
// polling from a hidden tab).
const sessionsCache = new Map<number, AgentSession[]>();
const runsCache = new Map<number, AgentRun[]>();

/** Per-project agent HQ: providers, persistent terminal sessions, and card runs. */
export function AgentsPanel({ projectId, visible }: { projectId: number; visible: boolean }) {
  const [providers, setProviders] = useState<AgentProviderStatus[] | null>(null);
  const [sessions, setSessions] = useState<AgentSession[] | null>(
    () => sessionsCache.get(projectId) ?? null,
  );
  const [runs, setRuns] = useState<AgentRun[] | null>(() => runsCache.get(projectId) ?? null);
  const [selected, setSelected] = useState<WorkKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [input, setInput] = useState('');
  const [queuedNote, setQueuedNote] = useState(false);
  const [usage, setUsage] = useState<Record<number, AgentTokenUsage | null>>({});

  // Only sets state in promise callbacks, so effects may call it directly.
  const load = useCallback(
    () =>
      Promise.all([api.listSessions(projectId), api.listRuns(projectId)]).then(
        ([s, r]) => {
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
            if (prev && items.some((w) => workKey(w) === prev)) return prev;
            return items[0] ? workKey(items[0]) : null;
          });
        },
        (e: Error) => setError(e.message),
      ),
    [projectId],
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
        >
          Open in workspace
        </Link>
        {s.status === 'running' ? (
          <button
            type="button"
            className="btn btn-sm"
            title="Stop the process (it won't relaunch until you start it)"
            onClick={() => changeSession(() => api.stopSession(s.id))}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            title={s.resumeSupported ? 'Start again, resuming the conversation' : 'Start again'}
            onClick={() => changeSession(() => api.startSession(s.id))}
          >
            Start
          </button>
        )}
        <ConfirmDelete
          label={`Delete session "${s.name}"`}
          heading={`Delete session "${s.name}"?`}
          message="Stops the process if it's running and deletes its log. This can't be undone."
          onConfirm={async () => {
            try {
              await api.deleteSession(s.id);
              setSessions((prev) => prev?.filter((x) => x.id !== s.id) ?? prev);
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
  const keyBuffer = useRef('');
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyChain = useRef<Promise<void>>(Promise.resolve());
  function sendKeys(sessionId: number, data: string) {
    keyBuffer.current += data;
    if (keyTimer.current) return;
    keyTimer.current = setTimeout(() => {
      const chunk = keyBuffer.current;
      keyBuffer.current = '';
      keyTimer.current = null;
      keyChain.current = keyChain.current
        .then(() => api.sendSessionInput(sessionId, chunk))
        .then(
          ({ queued }) => {
            if (queued) setQueuedNote(true);
          },
          (e: Error) => setError(e.message),
        );
    }, 12);
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
    <div className="agents">
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

      <section className="panel" aria-label="Agent work">
        <div className="panel-header">
          <h2>Agent work</h2>
          <span
            className="meta"
            title="Terminal: an interactive session you type into; it keeps running until you stop it. One-shot: a card dispatch that runs once, then waits for you to accept or reject its changes."
          >
            Terminals keep running until stopped · one-shot runs wait for your review
          </span>
        </div>
        {work === null ? (
          <div className="skeleton" style={{ height: 120 }} />
        ) : work.length === 0 ? (
          <p className="faint" style={{ margin: 0 }}>
            Nothing yet. Start a terminal session above, or open a card on the Board and hand it to
            an agent.
          </p>
        ) : (
          <AgentWorkList
            items={work}
            selected={selected}
            onSelect={setSelected}
            now={now}
            tokens={usage}
            actions={sessionActions}
          />
        )}

        {active && (
          <div className="terminal-wrap">
            <div className="terminal-head">
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
              <span className="faint mono truncate" title={active.cwd}>
                {active.cwd}
              </span>
              <span className="faint" style={{ fontSize: 12 }}>
                {active.status}
                {active.pid ? ` · pid ${active.pid}` : ''}
              </span>
            </div>
            <Suspense fallback={<div className="terminal skeleton" style={{ height: 380 }} />}>
              <TerminalView
                key={`${active.id}-${active.terminal}`}
                historyBytes={active.logBytes}
                height={active.terminal === 'pty' ? 380 : 320}
                fetchOutput={(after) => api.sessionOutput(active.id, after)}
                streamUrl={(after) => api.sessionStreamUrl(active.id, after)}
                paused={!visible}
                {...(active.terminal === 'pty'
                  ? {
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
            {active.terminal === 'pty' ? (
              <p className="faint" style={{ margin: '6px 0 0', fontSize: 12.5 }}>
                Click the terminal and type: keystrokes (including Ctrl+C and arrow keys) go
                straight to the session.
                {active.status !== 'running' &&
                  ' The session is down; input queues until it restarts.'}
              </p>
            ) : (
              <form className="terminal-input" onSubmit={sendInput}>
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
              <div className="notice" role="status">
                <span>Queued — it flushes into the session when the process is back.</span>
                <button className="btn btn-sm" onClick={() => setQueuedNote(false)}>
                  Dismiss
                </button>
              </div>
            )}
          </div>
        )}
        {activeRun && (
          <div className="runs">
            <RunCard
              run={activeRun}
              now={now}
              paused={!visible}
              onChanged={upsertRun}
              onDeleted={(id) => setRuns((prev) => prev?.filter((x) => x.id !== id) ?? prev)}
            />
          </div>
        )}
      </section>

      <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
        Sessions run on this machine as your user, rooted in the project folder by default, and only
        answer this page — the API refuses anything but same-machine requests. Sessions keep running
        when ProjectManager restarts, relaunch after crashes and reboots, and are only removed when
        you stop or delete them; input typed while one is down waits in a durable queue.
      </p>
    </div>
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
  const [providerId, setProviderId] = useState('shell');
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
