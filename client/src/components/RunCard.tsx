import { Suspense, lazy, useState } from 'react';
import { AGENT_AUTONOMY_LABELS, type AgentRun } from '../../../shared/types';
import { api } from '../api';
import { Dropdown } from './Dropdown';
import { formatBytes, formatDuration, formatRelative } from '../format';
import { ConfirmDelete } from './ConfirmDelete';

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
  return formatDuration(end - start);
}

/** One agent run: status, output, stop/retry, and the validate step that moves
    the linked card through its lifecycle. Used in the Agents tab and the card dialog. */
export function RunCard({
  run,
  now,
  onChanged,
  onDeleted,
  paused = false,
  hideHeader = false,
}: {
  run: AgentRun;
  now: number;
  onChanged: (run: AgentRun) => void;
  onDeleted: (id: number) => void;
  /** Stops output traffic while the surrounding tab is hidden. */
  paused?: boolean;
  /** Hides name + meta: the list row above already says it (workspace list view). */
  hideHeader?: boolean;
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
    <div className="run-card" aria-label={hideHeader ? `Run details: ${run.name}` : undefined}>
      {!hideHeader && (
        <>
          <div className="run-head">
            <span className={STATUS_BADGE[run.status]}>
              {active && <span className="spinner" style={{ width: 10, height: 10 }} />}
              {run.status === 'succeeded' && '✓ '}
              {run.status === 'failed' && '✗ '}
              {run.status}
              {run.attempts > 1 && ` · try ${run.attempts}`}
            </span>
            <span
              className="truncate"
              style={{ flex: 1 }}
              title={run.prompt || run.command.join(' ')}
            >
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
            <span title="What the agent was allowed to do">
              {AGENT_AUTONOMY_LABELS[run.autonomy]}
            </span>
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
        </>
      )}

      {run.error && <div className="error-banner">{run.error}</div>}

      {run.changes && !active && <RunChangesSummary run={run} />}

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
              <Dropdown
                label="Move accepted card to"
                value={moveTo}
                options={[
                  { value: 'review' as const, label: 'Review' },
                  { value: 'done' as const, label: 'Done' },
                ]}
                onChange={setMoveTo}
                disabled={busy}
              />
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
        <ConfirmDelete
          label="Delete run record"
          heading="Delete this run record?"
          message="Removes the run's output and change summary. The card stays where it is."
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
          <TerminalView
            fetchOutput={(after) => api.runOutput(run.id, after)}
            height={280}
            paused={paused}
          />
        </Suspense>
      )}
    </div>
  );
}

/** Evidence for validation: what the run actually changed in the project's git work tree. */
function RunChangesSummary({ run }: { run: AgentRun }) {
  const changes = run.changes!;
  const nothing = changes.files.length === 0 && changes.commits === 0;
  if (nothing) {
    return run.autonomy === 'read' ? (
      <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
        No files changed (read-only run).
      </p>
    ) : (
      <div className="notice notice-warn" role="status">
        <span>
          ⚠ No files changed. The agent may have been blocked or only answered: read the output
          before accepting.
        </span>
      </div>
    );
  }
  const label = [
    `${changes.files.length} file${changes.files.length === 1 ? '' : 's'} changed`,
    changes.commits > 0 && `${changes.commits} commit${changes.commits === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <details className="run-changes">
      <summary>{label}</summary>
      <ul className="mono">
        {changes.files.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
    </details>
  );
}
