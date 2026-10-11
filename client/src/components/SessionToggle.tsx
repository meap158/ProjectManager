import { useState } from 'react';
import type { AgentSession } from '../../../shared/types';
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
}: {
  session: AgentSession;
  onStart: () => void;
  onStop: () => void;
  onRestart?: () => Promise<unknown>;
}) {
  const [restarting, setRestarting] = useState(false);
  const busy = restarting || (!!session.restartProgress && session.restartProgress !== 'failed');
  return session.status === 'running' || busy ? (
    <>
      {onRestart && (
        <button
          type="button"
          className="btn btn-sm btn-icon session-restart"
          aria-label={`Restart ${session.name}`}
          title="Restart session (stop, then start)"
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
        title="Stop the process (it won't relaunch until you start it)"
        aria-label={`Stop ${session.name}`}
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
      title={session.resumeSupported ? 'Start again, resuming the conversation' : 'Start again'}
      onClick={onStart}
    >
      <PlayIcon size={11} />
      Start
    </button>
  );
}
