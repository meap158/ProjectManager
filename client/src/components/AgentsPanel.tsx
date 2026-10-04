import { Suspense, lazy, useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AgentProviderStatus, AgentRun, AgentSession } from '../../../shared/types';
import { api } from '../api';
import { formatBytes } from '../format';
import { RunCard } from './RunCard';
import { DeleteButton } from './ui/delete-button';

// xterm is heavy: it loads only when a terminal actually renders.
const TerminalView = lazy(() =>
  import('./TerminalView').then((m) => ({ default: m.TerminalView })),
);

/** Per-project agent HQ: providers, persistent terminal sessions, and card runs. */
export function AgentsPanel({ projectId }: { projectId: number }) {
  const [providers, setProviders] = useState<AgentProviderStatus[] | null>(null);
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [input, setInput] = useState('');
  const [queuedNote, setQueuedNote] = useState(false);

  // Only sets state in promise callbacks, so effects may call it directly.
  const load = useCallback(
    () =>
      Promise.all([api.listSessions(projectId), api.listRuns(projectId)]).then(
        ([s, r]) => {
          setSessions(s);
          setRuns(r);
          setNow(Date.now());
          setError(null);
          setActiveId((prev) => {
            if (prev !== null && s.some((x) => x.id === prev)) return prev;
            return s.length > 0 ? s[s.length - 1]!.id : null;
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
  // refreshes never blank what is on screen).
  const alive =
    sessions?.some((s) => s.status === 'running') ??
    runs?.some((r) => r.status === 'running' || r.status === 'queued') ??
    false;
  useEffect(() => {
    const timer = setTimeout(load, alive ? 2000 : 10000);
    return () => clearTimeout(timer);
  }, [alive, sessions, runs, load]);

  const active = sessions?.find((s) => s.id === activeId) ?? null;

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

      <section className="panel" aria-label="Providers">
        <div className="panel-header">
          <h2>Providers</h2>
          <span className="meta">AI CLIs on PATH · custom commands always available</span>
        </div>
        {providers === null ? (
          <div className="skeleton" style={{ height: 40 }} />
        ) : (
          <ul className="list provider-list">
            {providers.map((p) => (
              <li key={p.id}>
                <span className={`status-dot ${p.available ? 'green' : ''}`} />
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
                {!p.available && p.binary && <span className="badge">not on PATH</span>}
              </li>
            ))}
          </ul>
        )}
        <NewSessionForm
          projectId={projectId}
          providers={providers ?? []}
          onCreated={(s) => {
            setSessions((prev) => [...(prev ?? []), s]);
            setActiveId(s.id);
          }}
          onError={setError}
        />
      </section>

      <section className="panel" aria-label="Terminal sessions">
        <div className="panel-header">
          <h2>Sessions</h2>
          <span className="meta">persistent · survive restarts when supervised</span>
        </div>
        {sessions === null ? (
          <div className="skeleton" style={{ height: 120 }} />
        ) : sessions.length === 0 ? (
          <p className="faint" style={{ margin: 0 }}>
            No sessions yet. Start one above — an AI CLI REPL or a plain shell, ready to drive from
            here.
          </p>
        ) : (
          <ul className="list session-list">
            {sessions.map((s) => (
              <li key={s.id} className={s.id === activeId ? 'selected' : undefined}>
                <button
                  type="button"
                  className={`session-row${s.id === activeId ? ' is-active' : ''}`}
                  onClick={() => setActiveId(s.id)}
                  title={`${s.command.join(' ')}\n${s.cwd}`}
                >
                  <SessionDot session={s} />
                  <span className="truncate" style={{ flex: 1 }}>
                    <b>{s.name}</b> <span className="faint">· {s.providerId}</span>
                  </span>
                  {s.supervise && s.desiredState === 'running' && (
                    <span
                      className="badge"
                      title={
                        s.resumeSupported
                          ? 'Resumes conversation after reboot'
                          : 'Relaunches after reboot'
                      }
                    >
                      {s.resumeSupported ? '↻ resume' : '↻ supervised'}
                    </span>
                  )}
                  {s.restarts > 0 && (
                    <span className="badge" title={`Relaunched ${s.restarts}× after crashes`}>
                      {s.restarts}↻
                    </span>
                  )}
                  {s.queuedInputBytes > 0 && (
                    <span className="badge" title="Stdin queued while the session is down">
                      {formatBytes(s.queuedInputBytes)} queued
                    </span>
                  )}
                  <span className="faint num" style={{ fontSize: 12 }}>
                    {s.status}
                  </span>
                </button>
                <span className="actions">
                  {s.status === 'running' ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        try {
                          const next = await api.stopSession(s.id);
                          setSessions(
                            (prev) => prev?.map((x) => (x.id === s.id ? next : x)) ?? prev,
                          );
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        try {
                          const next = await api.startSession(s.id);
                          setSessions(
                            (prev) => prev?.map((x) => (x.id === s.id ? next : x)) ?? prev,
                          );
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      Start
                    </button>
                  )}
                  <DeleteButton
                    title={`Delete session "${s.name}" (stops the process)`}
                    onConfirm={async () => {
                      try {
                        await api.deleteSession(s.id);
                        setSessions((prev) => prev?.filter((x) => x.id !== s.id) ?? prev);
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}

        {active && (
          <div className="terminal-wrap">
            <div className="terminal-head">
              <b className="truncate">{active.name}</b>
              <span className="faint mono truncate" title={active.cwd}>
                {active.cwd}
              </span>
              <span className="faint" style={{ fontSize: 12 }}>
                {active.status}
                {active.pid ? ` · pid ${active.pid}` : ''}
              </span>
            </div>
            <Suspense fallback={<div className="terminal skeleton" style={{ height: 320 }} />}>
              <TerminalView
                key={active.id}
                fetchOutput={(after) => api.sessionOutput(active.id, after)}
              />
            </Suspense>
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
      </section>

      <section className="panel" aria-label="Card runs">
        <div className="panel-header">
          <h2>Runs</h2>
          <span className="meta">one-shot card dispatches · validate to move cards</span>
        </div>
        {runs === null ? (
          <div className="skeleton" style={{ height: 120 }} />
        ) : runs.length === 0 ? (
          <p className="faint" style={{ margin: 0 }}>
            No runs yet. Open a card on the Board and dispatch it to an AI CLI — the run shows up
            here for review and validation.
          </p>
        ) : (
          <div className="runs">
            {runs.map((r) => (
              <RunCard
                key={r.id}
                run={r}
                now={now}
                onChanged={upsertRun}
                onDeleted={(id) => setRuns((prev) => prev?.filter((x) => x.id !== id) ?? prev)}
              />
            ))}
          </div>
        )}
      </section>

      <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
        Sessions run on this machine as your user, rooted in the project folder by default, and only
        answer this page — the API refuses anything but same-machine requests. Supervised sessions
        relaunch after crashes, server restarts and machine reboots; input typed while one is down
        waits in a durable queue.
      </p>
    </div>
  );
}

function SessionDot({ session: s }: { session: AgentSession }) {
  const color =
    s.status === 'running'
      ? 'var(--good, #0ca30c)'
      : s.status === 'dead'
        ? 'var(--danger)'
        : 'var(--series-other)';
  const label =
    s.status === 'running' ? 'Running' : s.status === 'dead' ? 'Dead' : `Ended (${s.status})`;
  return (
    <span
      className="status-dot"
      style={{ background: color }}
      title={label}
      role="img"
      aria-label={label}
    />
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
  const [supervise, setSupervise] = useState(true);
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
              supervise,
            }
          : {
              providerId,
              ...(name.trim() ? { name: name.trim() } : {}),
              supervise,
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
          <select
            id="agent-provider"
            className="select"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.name}
                {!p.available ? ' (not on PATH)' : ''}
              </option>
            ))}
          </select>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional)"
            maxLength={80}
            aria-label="Session name"
          />
          <label className="check" title="Relaunch after crashes, restarts and reboots">
            <input
              type="checkbox"
              checked={supervise}
              onChange={(e) => setSupervise(e.target.checked)}
            />
            Supervise
          </label>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
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
