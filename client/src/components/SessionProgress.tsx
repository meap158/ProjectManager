import { useEffect, useRef, useState } from 'react';
import type { AgentSession, CodexAccountsState } from '../../../shared/types';
import { api } from '../api';
import { Dropdown } from './Dropdown';
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
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

/**
 * Shared feedback in list rows and the selected terminal header: Codex terminals' auto-continue
 * and, when the CLI shows its plan usage limit, a notice like Claude desktop's (PM-58): when it
 * resets in your timezone, "Auto-continue when limits reset", Try again, Switch account (PM-164),
 * and View details. Switching account changes the Codex login in Settings for every Codex CLI.
 */
export function SessionProgress({
  session,
  onChanged,
}: {
  session: AgentSession;
  onChanged?: (session: AgentSession) => void;
}) {
  const saving = useRef(false);
  const [saved, setSaved] = useState<{
    id: number;
    continuation: AgentSession['autoContinue'];
  } | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [pending, setPending] = useState<'toggle' | 'retry' | 'switch' | null>(null);
  const [error, setError] = useState('');
  const [details, setDetails] = useState(false);
  const [accountsState, setAccountsState] = useState<CodexAccountsState | null>(null);
  const continuation = saved?.id === session.id ? saved.continuation : session.autoContinue;
  useEffect(() => {
    if (
      saved?.id === session.id &&
      !saving.current &&
      session.autoContinue?.enabled === saved.continuation?.enabled
    )
      setSaved(null);
  }, [session.autoContinue, session.id, saved]);
  const limit = session.usageLimit ?? null;
  const limited = !!limit;
  const limitResetsAt = limit?.resetsAt;
  const enabled = !!continuation?.enabled;
  const resumesAt = enabled ? (continuation?.resumesAt ?? null) : null;
  const resetAt = resumesAt ?? limit?.resetsAt ?? null;
  useEffect(() => {
    if (!resetAt) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [resetAt]);

  useEffect(() => {
    if (!limited || session.providerId !== 'codex' || typeof api.getCodexAccounts !== 'function')
      return;
    let active = true;
    api
      .getCodexAccounts()
      .then((s) => {
        if (active) setAccountsState(s);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [limited, limitResetsAt, session.providerId, session.codexAccountId]);

  if (session.providerId !== 'codex' || session.terminal !== 'pty') return null;
  const msLeft = resetAt ? Date.parse(resetAt) - clock : null;
  const due = msLeft !== null && msLeft <= 0;
  const minutesLeft = msLeft !== null ? Math.max(0, Math.ceil(msLeft / 60_000)) : 0;
  const waitText = due
    ? 'due now'
    : msLeft !== null && msLeft < 60_000
      ? 'in under a minute'
      : `in ${minutesLeft} min`;
  const act = async (kind: 'toggle' | 'retry' | 'switch', call: () => Promise<unknown>) => {
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

  const currentAccountKey = session.codexAccountId ?? 'default';
  const otherAccounts = accountsState
    ? [
        ...(currentAccountKey !== 'default'
          ? [{ id: 'default', name: 'Default Codex account' }]
          : []),
        ...accountsState.accounts
          .filter((a) => a.id !== currentAccountKey)
          .map((a) => ({ id: a.id, name: a.name })),
      ]
    : [];

  return (
    // Clicks here act on these controls, never on the row or pane around them.
    <span
      className={`session-progress${limit ? ' is-limited' : ''}`}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {session.codexAccountName &&
        session.codexAccountId &&
        session.codexAccountId !== 'default' && (
          <span className="badge" title={`Codex account: ${session.codexAccountName}`}>
            {session.codexAccountName}
          </span>
        )}
      {limit ? (
        <span
          className="session-limit"
          role="status"
          title={resetAt ? fullTime(resetAt) : undefined}
        >
          Usage limit{resetAt && ` · resets ${shortTime(resetAt)}`}
          {due && ' · due'}
        </span>
      ) : (
        resumesAt && (
          <span className="faint session-resume-time" title={fullTime(resumesAt)}>
            Resumes {shortTime(resumesAt)} · {due ? 'due' : `${minutesLeft}m`}
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
          onChange={() => {
            if (saving.current) return;
            saving.current = true;
            const previous = continuation;
            setSaved({
              id: session.id,
              continuation: { enabled: !enabled, resumesAt: null, message: 'Saving auto-continue' },
            });
            void act('toggle', async () => {
              try {
                const next = await api.setAutoContinue(session.id, !enabled);
                setSaved({
                  id: session.id,
                  continuation: next.autoContinue ?? {
                    enabled: !enabled,
                    resumesAt: null,
                    message: '',
                  },
                });
                onChanged?.(next);
              } catch (error) {
                setSaved({ id: session.id, continuation: previous });
                throw error;
              } finally {
                saving.current = false;
              }
            });
          }}
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
          {otherAccounts.length > 0 && (
            <Dropdown
              label="Switch Codex account for every session"
              disabled={pending !== null}
              value=""
              options={[
                {
                  value: '',
                  label:
                    pending === 'switch' ? 'Switching…' : 'Switch account everywhere & continue…',
                  disabled: true,
                  hint: 'Choose an account',
                },
                ...otherAccounts.map((acc) => ({ value: acc.id, label: acc.name })),
              ]}
              onChange={(val) => {
                if (!val) return;
                void act('switch', () =>
                  api.switchSessionCodexAccount(session.id, val === 'default' ? null : val, true),
                );
              }}
            />
          )}
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
      <span className="sr-only" aria-live="polite">
        {pending === 'toggle' ? 'Saving auto-continue' : ''}
      </span>
      {error && (
        <span className="session-progress-error" role="alert">
          {error}
        </span>
      )}
      {limit && details && (
        <span className="session-limit-details">
          {resetAt
            ? due
              ? `Codex's plan limit should have reset by ${fullTime(resetAt)}; this notice clears on the next check.`
              : `Codex's plan limit resets ${fullTime(resetAt)}, ${waitText}.`
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
