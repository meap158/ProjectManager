import { useAgentLimits } from '../agentLimits';
import { formatRelative, formatReset } from '../format';
import { PROVIDER_LABELS, ProviderIcon } from './icons';

/**
 * A slim section under an Agent work list (PM-18, moved out of the list header in PM-42): plan
 * usage for the CLIs that list uses, once per provider, because limits belong to the account,
 * not to a session or run. Hidden when none of them reports limits.
 */
export function LimitsStrip({ providerIds }: { providerIds: string[] }) {
  const { list, now } = useAgentLimits();
  const shown = list.filter((l) => providerIds.includes(l.providerId));
  if (shown.length === 0) return null;
  return (
    <section className="limits-strip" aria-label="Plan usage limits">
      <span className="limits-title">Plan usage</span>
      {shown.map((l) => (
        <span
          key={l.providerId}
          className="limits-chip"
          title={`From the ${l.source}, reported ${formatRelative(l.asOf)}`}
        >
          <span className="limits-name">
            <ProviderIcon id={l.providerId} size={13} />
            {PROVIDER_LABELS[l.providerId] ?? l.providerId}
          </span>
          {l.windows.map((w) => {
            const level = w.usedPercent >= 90 ? 'high' : w.usedPercent >= 75 ? 'warn' : 'ok';
            const reset = w.resetSinceReport
              ? 'reset since the last report'
              : w.resetsAt
                ? `resets ${formatReset(w.resetsAt, now)}`
                : '';
            return (
              <span key={w.label} className="limits-window" title={reset || undefined}>
                <span className="faint">{w.label}</span>
                <span
                  className={`usage-meter is-${level}`}
                  role="meter"
                  aria-label={`${PROVIDER_LABELS[l.providerId] ?? l.providerId} ${w.label} limit used`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(w.usedPercent)}
                >
                  <span style={{ width: `${w.usedPercent}%` }} />
                </span>
                <span className="num">{Math.round(w.usedPercent)}%</span>
              </span>
            );
          })}
        </span>
      ))}
    </section>
  );
}
