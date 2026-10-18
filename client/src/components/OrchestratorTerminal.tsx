import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSession } from '../../../shared/types';
import { api } from '../api';
import { TerminalInputQueue } from '../lib/terminalInputQueue';
import { sendImageToSession } from '../sessionImages';
import { SessionChat, ViewSwitch, useSessionView } from './SessionChat';
import { SessionImageButton } from './SessionImageButton';
import { SessionToggle } from './SessionToggle';
import { SessionRestartStatus } from './SessionProgress';
const TerminalView = lazy(() =>
  import('./TerminalView').then((m) => ({ default: m.TerminalView })),
);

const CHAT_MAX_KEY = 'pm.orchestrator.chatMaxed';

function maxScopeKey(session: AgentSession): string {
  return String(session.orchestratorId ?? session.id);
}

function readChatMaxed(key: string): boolean {
  try {
    const raw = localStorage.getItem(CHAT_MAX_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Boolean(parsed && typeof parsed === 'object' && parsed[key]);
  } catch {
    return false;
  }
}

function writeChatMaxed(key: string, isMaxed: boolean): void {
  try {
    const raw = localStorage.getItem(CHAT_MAX_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    const next = parsed && typeof parsed === 'object' ? { ...parsed } : {};
    if (isMaxed) next[key] = true;
    else delete next[key];
    localStorage.setItem(CHAT_MAX_KEY, JSON.stringify(next));
  } catch {
    // Persisting expanded layout state is a convenience only.
  }
}

export function OrchestratorTerminal({
  session,
  onChanged,
  onSessionChanged,
}: {
  session: AgentSession;
  onChanged: () => void;
  onSessionChanged?: (session: AgentSession) => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function change(action: () => Promise<AgentSession>) {
    setBusy(true);
    setError('');
    try {
      const next = await action();
      onSessionChanged?.(next);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const pasteRef = useRef<((text: string) => void) | null>(null);
  // Full screen, the same affordance as an agent pane (PM-138): the header double-click or the
  // button grows the pane to fill the window (the whole screen on phones), Escape restores it.
  const scopeKey = maxScopeKey(session);
  const [maxedByScope, setMaxedByScope] = useState<Record<string, boolean>>({});
  const maxed = maxedByScope[scopeKey] ?? readChatMaxed(scopeKey);
  const updateMaxed = (next: boolean | ((prev: boolean) => boolean)) => {
    setMaxedByScope((prev) => {
      const current = prev[scopeKey] ?? readChatMaxed(scopeKey);
      const resolved = typeof next === 'function' ? next(current) : next;
      writeChatMaxed(scopeKey, resolved);
      return { ...prev, [scopeKey]: resolved };
    });
  };
  useEffect(() => {
    if (!maxed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMaxedByScope((prev) => ({ ...prev, [scopeKey]: false }));
        writeChatMaxed(scopeKey, false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maxed, scopeKey]);
  // Same Chat/Terminal choice as an agent pane: native chat on phones and touch
  // screens for CLIs with a transcript, terminal everywhere else.
  const sessionView = useSessionView(session);
  const queue = useMemo(
    () =>
      new TerminalInputQueue(
        async (text) => {
          await api.sendSessionInput(session.id, text);
        },
        (e) => setError(e.message),
      ),
    [session.id],
  );
  return (
    <section
      aria-label={`${session.name} terminal`}
      className={`orchestrator-terminal${maxed ? ' is-max' : ''}`}
    >
      <div
        className="orchestrator-terminal-head"
        onDoubleClick={() => updateMaxed((v) => !v)}
        title="Double-click to maximise"
      >
        <span className="faint orchestrator-terminal-status">
          {busy ? 'Updating session...' : session.status}
        </span>
        <SessionRestartStatus session={session} />
        <fieldset disabled={busy} className="orchestrator-terminal-controls">
          <SessionToggle
            session={session}
            onStart={() => void change(() => api.startSession(session.id))}
            onStop={() => void change(() => api.stopSession(session.id))}
            onRestart={() => change(() => api.restartSession(session.id))}
          />
        </fieldset>
        <SessionImageButton
          sessionId={session.id}
          pasteRef={pasteRef}
          onError={setError}
          className="icon-btn"
        />
        {sessionView.available && (
          <ViewSwitch view={sessionView.view} onChange={sessionView.choose} />
        )}
        <span className="orchestrator-terminal-spacer" />
        <button
          type="button"
          className="icon-btn orchestrator-terminal-max"
          aria-label={maxed ? 'Restore layout' : 'Full screen'}
          title={maxed ? 'Restore layout' : 'Maximise terminal'}
          aria-pressed={maxed}
          onClick={() => updateMaxed((v) => !v)}
        >
          <svg
            width="18"
            height="18"
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
                maxed
                  ? 'M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5'
                  : 'M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5'
              }
            />
          </svg>
        </button>
      </div>
      <div className="orchestrator-terminal-body">
        {error && (
          <p role="alert" className="error-banner">
            {error}
          </p>
        )}
        {sessionView.view === 'chat' ? (
          <SessionChat key={session.id} session={session} onError={setError} pasteRef={pasteRef} />
        ) : (
          <Suspense fallback={<div className="terminal skeleton" style={{ height: 360 }} />}>
            <TerminalView
              key={`${session.id}-${session.startedAt}`}
              height={maxed ? '100%' : 360}
              historyBytes={session.logBytes}
              stopped={session.status !== 'running'}
              fetchOutput={(after) => api.sessionOutput(session.id, after)}
              streamUrl={(after) => api.sessionStreamUrl(session.id, after)}
              onInput={(text) => queue.push(text)}
              pasteRef={pasteRef}
              onImage={(file) =>
                sendImageToSession(session.id, file, pasteRef.current).catch((e: Error) =>
                  setError(e.message),
                )
              }
              onResize={(cols, rows) => {
                void api.resizeSession(session.id, cols, rows).catch(() => undefined);
              }}
            />
          </Suspense>
        )}
      </div>
    </section>
  );
}
