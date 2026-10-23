import { useRef, useState } from 'react';
import type { AgentSession } from '../../../shared/types';
import { api } from '../api';
import { useShortcutProps, useShortcutTitle, type ShortcutId } from '../shortcuts';

/** Explicitly submit a short nudge to this CLI, without restarting its conversation. */
export function SessionContinue({
  session,
  onError,
  shortcut,
}: {
  session: AgentSession;
  onError: (message: string) => void;
  /** The keyboard shortcut this button answers to (PM-244). */
  shortcut?: ShortcutId;
}) {
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const keys = useShortcutProps(shortcut);
  const title = useShortcutTitle(shortcut, 'Send “continue” to this session');
  if (
    !['codex', 'claude', 'opencode', 'grok', 'antigravity'].includes(session.providerId) ||
    session.status !== 'running'
  )
    return null;
  const restarting = !!session.restartProgress && session.restartProgress !== 'failed';
  return (
    <>
      <button
        type="button"
        className="btn btn-sm session-continue"
        aria-label={`Continue ${session.name}`}
        title={result || title}
        {...keys}
        disabled={busy || restarting}
        onClick={async () => {
          if (sending.current) return;
          sending.current = true;
          setBusy(true);
          setResult('');
          try {
            const pasted = await api.sendSessionInput(
              session.id,
              session.terminal === 'pty' ? '\x1b[200~continue\x1b[201~' : 'continue',
            );
            const entered = await api.sendSessionInput(
              session.id,
              session.terminal === 'pty' ? '\r' : '\n',
            );
            setResult(
              pasted.queued || entered.queued
                ? 'Continue queued for reconnection'
                : 'Continue sent',
            );
          } catch (error) {
            onError((error as Error).message);
          } finally {
            sending.current = false;
            setBusy(false);
          }
        }}
      >
        {busy ? (
          <span className="spinner" aria-hidden="true" />
        ) : result ? (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
          >
            <path d="m5 12 4 4L19 6" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
          >
            <path d="m5 5 10 7-10 7V5ZM19 5v14" />
          </svg>
        )}
        <span className="session-continue-label">
          {result ? (result.includes('queued') ? 'Queued' : 'Sent') : 'Continue'}
        </span>
      </button>
      <span className="sr-only" role="status">
        {result}
      </span>
    </>
  );
}
