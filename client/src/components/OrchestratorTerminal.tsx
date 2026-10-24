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
const TERMINAL_HEIGHT_KEY = 'pm.orchestrator.terminalHeight';
export const DEFAULT_ORCHESTRATOR_TERMINAL_HEIGHT = 480;
export const MIN_ORCHESTRATOR_TERMINAL_HEIGHT = 400;

function readTerminalHeight(): number {
  try {
    const raw = localStorage.getItem(TERMINAL_HEIGHT_KEY);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= MIN_ORCHESTRATOR_TERMINAL_HEIGHT
      ? parsed
      : DEFAULT_ORCHESTRATOR_TERMINAL_HEIGHT;
  } catch {
    return DEFAULT_ORCHESTRATOR_TERMINAL_HEIGHT;
  }
}

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
  const [terminalHeight, setTerminalHeight] = useState<number>(readTerminalHeight);
  const resizeTo = (h: number) => {
    const maxH = Math.max(
      MIN_ORCHESTRATOR_TERMINAL_HEIGHT,
      (window.visualViewport?.height ?? window.innerHeight) - 120,
    );
    const next = Math.round(Math.min(Math.max(h, MIN_ORCHESTRATOR_TERMINAL_HEIGHT), maxH));
    setTerminalHeight(next);
    try {
      localStorage.setItem(TERMINAL_HEIGHT_KEY, String(next));
    } catch {
      // Local storage disabled or full.
    }
  };
  const resetTerminalHeight = () => {
    setTerminalHeight(DEFAULT_ORCHESTRATOR_TERMINAL_HEIGHT);
    try {
      localStorage.removeItem(TERMINAL_HEIGHT_KEY);
    } catch {
      // Local storage disabled or full.
    }
  };
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
          <>
            <Suspense
              fallback={
                <div
                  className="terminal skeleton"
                  style={{ height: maxed ? '100%' : terminalHeight }}
                />
              }
            >
              <TerminalView
                key={`${session.id}-${session.startedAt}`}
                height={maxed ? '100%' : terminalHeight}
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
            {!maxed && (
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize orchestrator terminal"
                aria-valuenow={terminalHeight}
                tabIndex={0}
                className="work-resizer"
                title="Drag to resize · double-click to reset"
                onPointerDown={(e) => {
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {
                    // Pointer capture unsupported or denied.
                  }
                  const resizerEl = e.currentTarget;
                  const startY = e.clientY;
                  const startHeight = terminalHeight;
                  const onMove = (ev: PointerEvent) => {
                    const delta = ev.clientY - startY;
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
                onDoubleClick={resetTerminalHeight}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowUp') resizeTo(terminalHeight - 24);
                  else if (e.key === 'ArrowDown') resizeTo(terminalHeight + 24);
                  else return;
                  e.preventDefault();
                }}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}
