import { useEffect, useState } from 'react';
import type { AgentSession } from '../../../shared/types';
import { api } from '../api';
import './session-progress.css';

export function SessionRestartStatus({ session }: { session: AgentSession }) {
  const phase = session.restartProgress;
  if (!phase) return null;
  const label =
    phase === 'stopping'
      ? 'Stopping…'
      : phase === 'starting'
        ? 'Starting…'
        : phase === 'restoring'
          ? 'Restoring…'
          : 'Restart failed';
  return (
    <span
      className={`session-restart-status${phase === 'failed' ? ' is-error' : ''}`}
      role="status"
      title={session.restartError ?? (phase === 'restoring' ? 'Restoring conversation' : label)}
    >
      {phase !== 'failed' && <span className="spinner" aria-hidden="true" />}
      <span>{label}</span>
    </span>
  );
}

/** A time in the viewer's own timezone, e.g. "3:00 PM GMT+7". */
const shortTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
const fullTime = (iso: string) =>
  new Date(iso).toLocaleString([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

/**
 * Shared feedback in list rows and the selected terminal header: Codex terminals' auto-continue
 * and, when the CLI shows its plan usage limit, a notice like Claude desktop's (PM-58): when it
 * resets in your timezone, "Auto-continue when limits reset", Try again and View details.
 */
export function SessionProgress({ session }: { session: AgentSession }) {
  const [clock, setClock] = useState(() => Date.now());
  const [pending, setPending] = useState<'toggle' | 'retry' | null>(null);
  const [error, setError] = useState('');
  const [details, setDetails] = useState(false);
  const continuation = session.autoContinue;
  const limit = session.usageLimit ?? null;
  const enabled = !!continuation?.enabled;
  const resumesAt = enabled ? (continuation?.resumesAt ?? null) : null;
  const resetAt = resumesAt ?? limit?.resetsAt ?? null;
  useEffect(() => {
    if (!resetAt) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [resetAt]);

  if (session.providerId !== 'codex' || session.terminal !== 'pty') return null;
  const minutesLeft = resetAt ? Math.max(0, Math.ceil((Date.parse(resetAt) - clock) / 60_000)) : 0;
  const act = async (kind: 'toggle' | 'retry', call: () => Promise<unknown>) => {
    setPending(kind);
    setError('');
    try {
      await call();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(null);
    }
  };

  return (
    // Clicks here act on these controls, never on the row or pane around them.
    <span
      className={`session-progress${limit ? ' is-limited' : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      {limit ? (
        <span
          className="session-limit"
          role="status"
          title={resetAt ? fullTime(resetAt) : undefined}
        >
          Usage limit{resetAt && ` · resets ${shortTime(resetAt)}`}
        </span>
      ) : (
        resumesAt && (
          <span className="faint session-resume-time" title={fullTime(resumesAt)}>
            Resumes {shortTime(resumesAt)} · {minutesLeft}m
          </span>
        )
      )}
      <label
        className={`session-auto-continue${enabled ? ' is-on' : ''}`}
        title={
          continuation?.message ||
          'Continue once when the usage limit resets. Typing in the terminal cancels it.'
        }
      >
        <input
          type="checkbox"
          checked={enabled}
          disabled={pending !== null}
          aria-label={`Auto-continue ${session.name} when limits reset`}
          onChange={() => act('toggle', () => api.setAutoContinue(session.id, !enabled))}
        />
        <span className="session-auto-continue-label">
          {limit ? 'Auto-continue when limits reset' : 'Auto-continue'}
        </span>
      </label>
      {limit && (
        <>
          <button
            type="button"
            className="btn btn-sm"
            disabled={pending !== null}
            onClick={() => act('retry', () => api.continueSessionNow(session.id))}
          >
            {pending === 'retry' ? 'Sending…' : 'Try again'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            aria-expanded={details}
            onClick={() => setDetails(!details)}
          >
            View details
          </button>
        </>
      )}
      {pending === 'toggle' && <span className="spinner" aria-label="Saving" />}
      {error && (
        <span className="session-progress-error" role="alert">
          {error}
        </span>
      )}
      {limit && details && (
        <span className="session-limit-details">
          {resetAt
            ? `Codex's plan limit resets ${fullTime(resetAt)}, in ${minutesLeft} min.`
            : "Codex hasn't reported when this limit resets."}{' '}
          {enabled
            ? 'Auto-continue then sends "Continue the interrupted task" once; typing in the terminal cancels it.'
            : 'Turn on auto-continue to resume once it resets, or try again now.'}
          {enabled && continuation?.message && ` Status: ${continuation.message}.`}
        </span>
      )}
    </span>
  );
}
