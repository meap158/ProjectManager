import { Suspense, lazy, useState } from 'react';
import type { AgentRun } from '../../../shared/types';
import { api } from '../api';
import { formatBytes, formatRelative } from '../format';
import { DeleteButton } from './ui/delete-button';

// xterm is heavy: it loads only when output is opened.
const TerminalView = lazy(() =>
  import('./TerminalView').then((m) => ({ default: m.TerminalView })),
);

const STATUS_BADGE: Record<AgentRun['status'], string> = {
  queued: 'badge',
  running: 'badge',
  succeeded: 'badge badge-done',
  failed: 'badge badge-danger',
  killed: 'badge',
};

function elapsed(run: AgentRun, now: number): string {
  const start = run.startedAt ? Date.parse(run.startedAt) : Date.parse(run.createdAt);
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** One agent run: status, output, stop/retry, and the validate step that moves
    the linked card through its lifecycle. Used in the Agents tab and the card dialog. */
export function RunCard({
  run,
  now,
  onChanged,
  onDeleted,
}: {
  run: AgentRun;
  now: number;
  onChanged: (run: AgentRun) => void;
  onDeleted: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [moveTo, setMoveTo] = useState<'review' | 'done'>('review');
  const [error, setError] = useState<string | null>(null);
  const active = run.status === 'queued' || run.status === 'running';
  const validatable = (run.status === 'succeeded' || run.status === 'failed') && !run.validation;

  async function act(fn: () => Promise<AgentRun>) {
    setBusy(true);
    setError(null);
    try {
      onChanged(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Retry replaces this record with a fresh run of the same prompt.
  async function retry() {
    setBusy(true);
    setError(null);
    try {
      const next = await api.retryRun(run.id);
      onDeleted(run.id);
      onChanged(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="run-card">
      <div className="run-head">
        <span className={STATUS_BADGE[run.status]}>
          {active && <span className="spinner" style={{ width: 10, height: 10 }} />}
          {run.status === 'succeeded' && '✓ '}
          {run.status === 'failed' && '✗ '}
          {run.status}
          {run.attempts > 1 && ` · try ${run.attempts}`}
        </span>
        <span className="truncate" style={{ flex: 1 }} title={run.prompt || run.command.join(' ')}>
          <b>{run.name}</b>
        </span>
        {run.cardKey && (
          <span className="mono faint" title="Linked card">
            {run.cardKey}
          </span>
        )}
      </div>

      <div className="run-meta faint">
        <span>{run.providerId}</span>
        <span aria-hidden="true">·</span>
        <span className="num">{elapsed(run, now)}</span>
        <span aria-hidden="true">·</span>
        <span className="num">{formatBytes(run.logBytes)}</span>
        {run.exitCode !== null && (
          <>
            <span aria-hidden="true">·</span>
            <span className="num">exit {run.exitCode}</span>
          </>
        )}
        {run.startedAt && (
          <span title={run.startedAt}>started {formatRelative(run.startedAt)}</span>
        )}
      </div>

      {run.error && <div className="error-banner">{run.error}</div>}

      {run.validation && (
        <div className="notice" role="status">
          <span>
            {run.validation === 'accepted' ? 'Accepted' : 'Rejected'}
            {run.validatedMove ? ` → ${run.validatedMove}` : ''} ·{' '}
            {run.validatedAt ? formatRelative(run.validatedAt) : ''}
          </span>
        </div>
      )}

      {validatable && (
        <div className="validate-row">
          <span className="faint">Validate:</span>
          {run.status === 'succeeded' && (
            <>
              <select
                className="select"
                aria-label="Move accepted card to"
                value={moveTo}
                onChange={(e) => setMoveTo(e.target.value as 'review' | 'done')}
                disabled={busy}
              >
                <option value="review">Review</option>
                <option value="done">Done</option>
              </select>
              <button
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() => act(() => api.validateRun(run.id, 'accepted', moveTo))}
              >
                Accept{run.cardId ? ` → ${moveTo}` : ''}
              </button>
            </>
          )}
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() => act(() => api.validateRun(run.id, 'rejected'))}
            title={run.cardId ? 'Send the card back to To do' : 'Mark rejected'}
          >
            Reject
          </button>
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={retry}
            title="Run again with the same prompt"
          >
            Retry
          </button>
        </div>
      )}

      {!validatable && !active && (
        <div className="validate-row">
          <button className="btn btn-sm" disabled={busy} onClick={retry}>
            Retry
          </button>
        </div>
      )}

      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      <div className="run-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? 'Hide output' : 'View output'}
        </button>
        {active && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => act(() => api.stopRun(run.id))}
          >
            Stop
          </button>
        )}
        <span style={{ flex: 1 }} />
        <DeleteButton
          title="Delete run record"
          onConfirm={async () => {
            try {
              await api.deleteRun(run.id);
              onDeleted(run.id);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        />
      </div>

      {open && (
        <Suspense fallback={<div className="terminal skeleton" style={{ height: 280 }} />}>
          <TerminalView fetchOutput={(after) => api.runOutput(run.id, after)} height={280} />
        </Suspense>
      )}
    </div>
  );
}
