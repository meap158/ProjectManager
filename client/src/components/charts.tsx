import { useMemo, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react';
import type { LanguageStats } from '../../../shared/types';
import { formatNumber } from '../format';
import type { Contribution, ContributionLevel } from './ui/github-activity';

// ---- Tooltip ----------------------------------------------------------------------------------

/** Hover/focus tooltip anchored above the target element. Render `node` once per chart. */
export function useTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  const show = (event: MouseEvent<Element> | FocusEvent<Element>, content: ReactNode) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setTip({ x: rect.left + rect.width / 2, y: rect.top, content });
  };
  const hide = () => setTip(null);
  const node = tip ? (
    <div className="tooltip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
      {tip.content}
    </div>
  ) : null;
  return { show, hide, node };
}

// ---- Language colours -------------------------------------------------------------------------

const SERIES_SLOTS = 7;

export interface Slice {
  name: string;
  value: number;
  color: string;
}

/**
 * Top languages get the categorical slots in fixed order (by size); the rest fold into a neutral
 * "Other" slice — never generated extra hues. See DESIGN.md → Data visualisation.
 */
export function languageSlices(
  languages: LanguageStats[],
  metric: 'code' | 'bytes' = 'code',
): Slice[] {
  const sorted = [...languages].filter((l) => l[metric] > 0).sort((a, b) => b[metric] - a[metric]);
  const head = sorted.slice(0, SERIES_SLOTS).map((l, i) => ({
    name: l.name,
    value: l[metric],
    color: `var(--series-${i + 1})`,
  }));
  const rest = sorted.slice(SERIES_SLOTS).reduce((sum, l) => sum + l[metric], 0);
  return rest > 0 ? [...head, { name: 'Other', value: rest, color: 'var(--series-other)' }] : head;
}

export function LanguageBar({
  languages,
  showLegend = true,
}: {
  languages: LanguageStats[];
  showLegend?: boolean;
}) {
  const tooltip = useTooltip();
  const slices = languageSlices(languages);
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) return <div className="langbar" aria-label="No recognised source code" />;
  const pct = (v: number) => (v / total) * 100;

  return (
    <div>
      <div
        className="langbar"
        role="img"
        aria-label={`Languages: ${slices.map((s) => `${s.name} ${pct(s.value).toFixed(1)}%`).join(', ')}`}
      >
        {slices.map((s) => (
          <span
            key={s.name}
            style={{ width: `${pct(s.value)}%`, background: s.color }}
            onMouseEnter={(e) =>
              tooltip.show(
                e,
                `${s.name} · ${pct(s.value).toFixed(1)}% · ${formatNumber(s.value)} lines`,
              )
            }
            onMouseLeave={tooltip.hide}
          />
        ))}
      </div>
      {showLegend && (
        <div className="legend">
          {slices.map((s) => (
            <span key={s.name}>
              <i className="swatch" style={{ background: s.color }} />
              <b>{s.name}</b> {pct(s.value).toFixed(1)}%
            </span>
          ))}
        </div>
      )}
      {tooltip.node}
    </div>
  );
}

// ---- Commit calendar data ---------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKS = 53;

export function localDateKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

/**
 * Converts per-day commit counts into the Sunday-aligned calendar the Rare UI GitHubActivity grid
 * expects (53 weeks ending today). Levels are quartiles of the busiest day, like GitHub.
 */
export function toContributions(dailyCommits: Record<string, number>): Contribution[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (WEEKS - 1) * 7 - today.getDay());

  const days: { date: string; count: number }[] = [];
  for (const d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const date = localDateKey(d);
    days.push({ date, count: dailyCommits[date] ?? 0 });
  }
  const max = Math.max(0, ...days.map((d) => d.count));
  return days.map((d) => ({
    ...d,
    level: (d.count === 0 ? 0 : Math.min(4, Math.ceil((d.count / max) * 4))) as ContributionLevel,
  }));
}

/** Heatmap colours (levels 1-4); level 0 uses the grid's own empty-cell tint. */
export const HEAT_SCALE = ['var(--heat-1)', 'var(--heat-2)', 'var(--heat-3)', 'var(--heat-4)'];

// ---- Commits per month (last 12 months) ---------------------------------------------------------

export function MonthlyCommits({ dailyCommits }: { dailyCommits: Record<string, number> }) {
  const tooltip = useTooltip();
  const months = useMemo(() => {
    const now = new Date();
    const buckets = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
      return { key: localDateKey(d).slice(0, 7), date: d, count: 0 };
    });
    const index = new Map(buckets.map((b, i) => [b.key, i]));
    for (const [day, count] of Object.entries(dailyCommits)) {
      const i = index.get(day.slice(0, 7));
      if (i !== undefined) buckets[i]!.count += count;
    }
    return buckets;
  }, [dailyCommits]);
  const max = Math.max(1, ...months.map((m) => m.count));
  const label = (d: Date) => d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div>
      <div className="columns-chart" aria-hidden="true">
        {months.map((m) => (
          <div
            key={m.key}
            className="col"
            onMouseEnter={(e) =>
              tooltip.show(e, `${label(m.date)}: ${formatNumber(m.count)} commits`)
            }
            onMouseLeave={tooltip.hide}
          >
            <span style={{ height: `${(m.count / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="columns-axis" aria-hidden="true">
        {months.map((m) => (
          <span key={m.key}>{MONTHS[m.date.getMonth()]!.slice(0, 1)}</span>
        ))}
      </div>
      <table className="sr-only">
        <caption>Commits per month</caption>
        <tbody>
          {months.map((m) => (
            <tr key={m.key}>
              <th scope="row">{label(m.date)}</th>
              <td>{m.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {tooltip.node}
    </div>
  );
}

// ---- Horizontal bars (single series) ------------------------------------------------------------

export function HorizontalBars({
  rows,
  format,
}: {
  rows: { label: string; value: number; hint?: string }[];
  format: (value: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div className="hbar" key={r.label} title={r.hint}>
          <span className="truncate mono">{r.label}</span>
          <div className="track">
            <div className="fill" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <span className="val">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}
