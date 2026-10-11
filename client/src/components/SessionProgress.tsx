import { useEffect, useState } from 'react';
import type { AgentSession } from '../../../shared/types';
import { api } from '../api';

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

/** Shared feedback in list rows and the selected terminal header. */
export function SessionProgress({ session }: { session: AgentSession }) {
  const [clock, setClock] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const continuation = session.autoContinue;
  useEffect(() => {
    if (!continuation?.resumesAt) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [continuation?.resumesAt]);
  return (
    <span className="session-progress">
      {session.providerId === 'codex' && session.terminal === 'pty' && (
        <button
          type="button"
          className="btn btn-sm session-auto-continue"
          aria-label={`Auto-continue for ${session.name}`}
          disabled={pending}
          aria-pressed={!!continuation?.enabled}
          title={
            continuation?.message ||
            'Continue once after an allowance reset; manual typing cancels it'
          }
          onClick={async (event) => {
            event.stopPropagation();
            setPending(true);
            setError('');
            try {
              await api.setAutoContinue(session.id, !continuation?.enabled);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setPending(false);
            }
          }}
        >
          {continuation?.enabled
            ? continuation.resumesAt
              ? `Cancel resume · ${Math.max(0, Math.ceil((Date.parse(continuation.resumesAt) - clock) / 60_000))}m`
              : 'Auto-continue on'
            : 'Auto-continue'}
        </button>
      )}
      {error && <span role="alert">{error}</span>}
      {continuation?.resumesAt && (
        <span className="faint session-resume-time" title={continuation.resumesAt}>
          Resumes{' '}
          {new Date(continuation.resumesAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      )}
    </span>
  );
}
