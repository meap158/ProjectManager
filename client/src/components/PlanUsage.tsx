import { useState } from 'react';
import { useAgentLimits } from '../agentLimits';
import { formatRelative, formatReset } from '../format';
import { PROVIDER_LABELS, ProviderIcon } from './icons';

const OPEN_KEY = 'pm.sidebar.usage';

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== 'closed';
  } catch {
    return true;
  }
}

/**
 * Sidebar card with plan usage (PM-41), after Claude Code's "Plan usage limits" popover: per CLI,
 * one row per window with its reset time and percent, and a thin bar under it (amber from 75%,
 * red from 90%). Collapses to a one-line summary of the highest use per CLI; the choice is saved
 * per browser. Hidden when no CLI reports limits.
 */
export function PlanUsage() {
  const { list, now } = useAgentLimits();
  const [open, setOpen] = useState(readOpen);
  if (list.length === 0) return null;
  const name = (id: string) => PROVIDER_LABELS[id] ?? id;
  const summary = list
    .map(
      (l) =>
        `${name(l.providerId)} ${Math.round(Math.max(...l.windows.map((w) => w.usedPercent)))}%`,
    )
    .join(' · ');
  return (
    <section className="plan-usage" aria-label="Plan usage limits">
      <button
        type="button"
        className="plan-usage-head"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          try {
            localStorage.setItem(OPEN_KEY, open ? 'closed' : 'open');
          } catch {
            // A per-browser convenience.
          }
        }}
      >
        <span className="plan-usage-title">Plan usage</span>
        {!open && <span className="faint truncate">{summary}</span>}
        <span className="blist-caret" aria-hidden="true" />
      </button>
      {open &&
        list.map((l) => (
          <div
            key={l.providerId}
            className="plan-usage-cli"
            title={`From the ${l.source}, reported ${formatRelative(l.asOf)}`}
          >
            <div className="plan-usage-name">
              <ProviderIcon id={l.providerId} size={12} />
              {name(l.providerId)}
            </div>
            {l.windows.map((w) => {
              const level = w.usedPercent >= 90 ? 'high' : w.usedPercent >= 75 ? 'warn' : 'ok';
              const resetTooltip = w.resetSinceReport
                ? 'Reset since the last report'
                : w.resetsAt
                  ? `Resets ${new Date(w.resetsAt).toLocaleString(undefined, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                      timeZoneName: 'short',
                    })}`
                  : undefined;
              return (
                <div key={w.label} className="plan-usage-row" title={resetTooltip}>
                  <div className="plan-usage-line">
                    <span>{w.label}</span>
                    <span className="faint">
                      {w.resetSinceReport
                        ? 'reset'
                        : w.resetsAt
                          ? `Resets ${formatReset(w.resetsAt, now)}`
                          : ''}
                    </span>
                    <span className="num">{Math.round(w.usedPercent)}%</span>
                  </div>
                  <div
                    className={`plan-usage-bar is-${level}`}
                    role="meter"
                    aria-label={`${name(l.providerId)} ${w.label} limit used`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(w.usedPercent)}
                  >
                    <span style={{ width: `${w.usedPercent}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        ))}
    </section>
  );
}
