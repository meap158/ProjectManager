import { useMemo, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react';
import type { LanguageStats } from '../../../shared/types';
import { formatNumber } from '../format';
import type { Contribution, ContributionLevel } from './ui/github-activity';

// ---- Tooltip ----------------------------------------------------------------------------------

/** Hover/focus tooltip anchored above the target element. Render `node` once per chart. */
export function useTooltip() {
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  /** Anchors above `anchor` when given (e.g. the visible mark inside a larger hit target). */
  const show = (
    event: MouseEvent<Element> | FocusEvent<Element>,
    content: ReactNode,
    anchor?: Element | null,
  ) => {
    const rect = (anchor ?? event.currentTarget).getBoundingClientRect();
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
  const label = (d: Date) => d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div>
      <ColumnChart
        yTitle="Commits"
        xTitle="Month"
        columns={months.map((m) => ({
          key: m.key,
          short: MONTHS[m.date.getMonth()]!,
          segments: [{ id: 'commits', value: m.count, color: 'var(--series-1)' }],
          tip: `${label(m.date)}: ${formatNumber(m.count)} commit${m.count === 1 ? '' : 's'}`,
        }))}
      />
      <div className="sr-only">
        <table>
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
      </div>
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

// ---- Column chart (single or stacked series) ----------------------------------------------------
// One frame for every columns chart (commits per month, commits by project), after AdRelay's
// DailyChart: a labelled y scale with round ticks and gridlines, axis lines, x labels thinned to
// fit (first and last always shown), values printed on the columns, and a hover tooltip.

/**
 * Gridline values: a round step first (1, 2, 2.5, 5 × 10ⁿ; whole numbers, since commits are
 * counts), then four of them, so every line carries a holdable number (0, 10, 20, 30, 40) and the
 * tallest column sits below the top line.
 */
export function columnTicks(max: number): number[] {
  const rough = Math.max(1, max) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10]
      .map((f) => f * magnitude)
      .find((candidate) => candidate >= rough && Number.isInteger(candidate)) ?? 10 * magnitude;
  return [0, step, step * 2, step * 3, step * 4];
}

/**
 * Which columns print their value: all non-zero ones when there is room, otherwise only the
 * peak and the latest non-zero column, so a dense chart never turns into a wall of numbers.
 */
export function valueLabelIndexes(totals: number[], roomForAll: number): Set<number> {
  if (totals.length <= roomForAll) {
    return new Set(totals.flatMap((n, i) => (n > 0 ? [i] : [])));
  }
  const shown = new Set<number>();
  let peak = -1;
  totals.forEach((n, i) => {
    if (n > 0 && (peak === -1 || n >= totals[peak]!)) peak = i;
  });
  if (peak !== -1) shown.add(peak);
  for (let i = totals.length - 1; i >= 0; i--) {
    if (totals[i]! > 0) {
      shown.add(i);
      break;
    }
  }
  return shown;
}

export interface ColumnSegment {
  id: string;
  value: number;
  color: string;
  dimmed?: boolean;
}

export interface ChartColumn {
  key: string;
  /** Under the column (may be thinned out). */
  short: string;
  segments: ColumnSegment[];
  tip: ReactNode;
}

export function ColumnChart({
  columns,
  yTitle,
  xTitle,
  height = 160,
}: {
  columns: ChartColumn[];
  yTitle: string;
  xTitle: string;
  height?: number;
}) {
  const tooltip = useTooltip();
  const totals = columns.map((c) => c.segments.reduce((sum, s) => sum + s.value, 0));
  const ticks = columnTicks(Math.max(0, ...totals));
  const top = ticks[ticks.length - 1]!;
  const labelled = valueLabelIndexes(totals, 16);
  const xEvery = columns.length <= 16 ? 1 : Math.ceil(columns.length / 8);
  // Every xEvery-th label plus the last; a regular label too close to the last one is dropped.
  const last = columns.length - 1;
  const showX = (i: number) => i === last || (i % xEvery === 0 && last - i >= xEvery / 2);

  return (
    <div className="colchart" aria-hidden="true">
      <span className="colchart-ytitle">{yTitle}</span>
      {/* Scale and plot share one inner area under a 16px headroom for the tallest value label. */}
      <div className="colchart-scale" style={{ height }}>
        <div className="colchart-area">
          {ticks.map((t) => (
            <span key={t} style={{ bottom: `${(t / top) * 100}%` }}>
              {formatNumber(t)}
            </span>
          ))}
        </div>
      </div>
      <div className="colchart-plot" style={{ height }}>
        <div className="colchart-area">
          {ticks.slice(1).map((t) => (
            <span key={t} className="colchart-grid" style={{ bottom: `${(t / top) * 100}%` }} />
          ))}
          {columns.map((c, i) => (
            <div
              key={c.key}
              className="colchart-col"
              onMouseEnter={(e) =>
                tooltip.show(e, c.tip, e.currentTarget.querySelector('.colchart-bar'))
              }
              onMouseLeave={tooltip.hide}
            >
              <div className="colchart-bar" style={{ height: `${(totals[i]! / top) * 100}%` }}>
                {labelled.has(i) && (
                  <span className="colchart-val">{formatNumber(totals[i]!)}</span>
                )}
                {c.segments
                  .filter((s) => s.value > 0)
                  .map((s) => (
                    <span
                      key={s.id}
                      style={{
                        flexGrow: s.value,
                        background: s.color,
                        opacity: s.dimmed ? 0.2 : 1,
                      }}
                    />
                  ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="colchart-x">
        {columns.map((c, i) => (
          <span key={c.key}>{showX(i) ? c.short : ''}</span>
        ))}
      </div>
      <span className="colchart-xtitle">{xTitle}</span>
      {tooltip.node}
    </div>
  );
}
