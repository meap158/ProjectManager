import { useState } from 'react';
import type { AgentSession } from '../../../shared/types';
import { useShortcutProps, useShortcutTitle, type ShortcutId } from '../shortcuts';
import { PlayIcon, StopIcon } from './icons';

/**
 * Start / Stop for a session row. The two look different at a glance (owner request PM-29): a
 * green play triangle to start, a red square to stop, plus the word, never colour alone.
 */
export function SessionToggle({
  session,
  onStart,
  onStop,
  onRestart,
  shortcuts,
}: {
  session: AgentSession;
  onStart: () => void;
  onStop: () => void;
  onRestart?: () => Promise<unknown>;
  /** Keyboard shortcuts these buttons answer to (PM-244): restart, and stop/start. */
  shortcuts?: { restart?: ShortcutId; toggle?: ShortcutId };
}) {
  const [restarting, setRestarting] = useState(false);
  const restartKeys = useShortcutProps(shortcuts?.restart);
  const toggleKeys = useShortcutProps(shortcuts?.toggle);
  const restartTitle = useShortcutTitle(shortcuts?.restart, 'Restart session (stop, then start)');
  const stopTitle = useShortcutTitle(
    shortcuts?.toggle,
    "Stop the process (it won't relaunch until you start it)",
  );
  const startTitle = useShortcutTitle(
    shortcuts?.toggle,
    session.resumeSupported ? 'Start again, resuming the conversation' : 'Start again',
  );
  const busy = restarting || (!!session.restartProgress && session.restartProgress !== 'failed');
  return session.status === 'running' || busy ? (
    <>
      {onRestart && (
        <button
          type="button"
          className="btn btn-sm btn-icon session-restart"
          aria-label={`Restart ${session.name}`}
          title={restartTitle}
          {...restartKeys}
          disabled={busy}
          onClick={async () => {
            setRestarting(true);
            try {
              await onRestart();
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
      )}
      <button
        type="button"
        className="btn btn-sm session-toggle stop"
        title={stopTitle}
        aria-label={`Stop ${session.name}`}
        {...toggleKeys}
        disabled={
          restarting ||
          session.restartProgress === 'stopping' ||
          session.restartProgress === 'starting'
        }
        onClick={onStop}
      >
        <StopIcon size={11} />
        <span className="session-toggle-label">Stop</span>
      </button>
    </>
  ) : (
    <button
      type="button"
      className="btn btn-sm session-toggle start"
      title={startTitle}
      {...toggleKeys}
      onClick={onStart}
    >
      <PlayIcon size={11} />
      Start
    </button>
  );
}
