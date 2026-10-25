import type { ProviderLimits } from '../../../shared/limits';
import { useEffect, useState } from 'react';
import { formatRelative, formatReset } from '../format';

/**
 * Plan usage meters for one agent CLI (PM-17): one row per window (5-hour, weekly) with a thin
 * bar, the percentage used and when it resets, the way the CLIs show it themselves. The numbers
 * are as of the CLI's last reply, so the source and time sit in the tooltip.
 */
export function UsageLimits({ limits, now }: { limits: ProviderLimits; now: number }) {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) setClock(Date.now());
    };
    const timer = window.setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  const currentTime = Math.max(now, clock);
  return (
    <span
      className="usage-limits"
      title={`From the ${limits.source}, reported ${formatRelative(limits.asOf)}`}
    >
      {limits.windows.map((w) => {
        const level = w.usedPercent >= 90 ? 'high' : w.usedPercent >= 75 ? 'warn' : 'ok';
        const reset = w.resetSinceReport
          ? 'reset due · awaiting refresh'
          : w.resetsAt
            ? Date.parse(w.resetsAt) <= currentTime
              ? 'reset due · awaiting refresh'
              : `resets ${formatReset(w.resetsAt, currentTime)}`
            : null;
        const resetTooltip = w.resetSinceReport
          ? 'Reset due · awaiting refresh'
          : w.resetsAt
            ? Date.parse(w.resetsAt) <= currentTime
              ? 'Reset due · awaiting refresh'
              : `Resets ${new Date(w.resetsAt).toLocaleString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                  timeZoneName: 'short',
                })}`
            : undefined;
        return (
          <span key={w.label} className="usage-window" title={resetTooltip}>
            <span className="usage-label">{w.label}</span>
            <span
              className={`usage-meter is-${level}`}
              role="meter"
              aria-label={`${w.label} limit used`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(w.usedPercent)}
            >
              <span style={{ width: `${w.usedPercent}%` }} />
            </span>
            <span className="num">{Math.round(w.usedPercent)}%</span>
            {reset && <span className="faint">{reset}</span>}
          </span>
        );
      })}
    </span>
  );
}
