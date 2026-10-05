import { useMemo, useState } from 'react';
import type { ProjectSummary } from '../../../shared/types';
import { formatNumber } from '../format';
import { localDateKey, useTooltip } from './charts';

// Commits over time, broken down by project (stacked columns): the stack height is the
// portfolio total and the segments show which projects drive it. Data-viz rules (DESIGN.md §5):
//  - Top 6 projects get the categorical slots in fixed order, ranked by 12-month commits, so a
//    project keeps its colour when the range changes. The tail folds into a gray "Other".
//  - 2px surface gaps between stacked segments, rounded top only, recessive gridlines.
//  - Hover tooltip per column, hover a legend entry to emphasise one project, table view.

type Range = 'months' | 'weeks';
const SERIES_SLOTS = 6;
const PERIODS = 12;
const RANGE_KEY = 'pm.commitsByProject.range';

interface Bucket {
  key: string;
  label: string;
  short: string;
  start: number;
  end: number;
}

function monthBuckets(): Bucket[] {
  const now = new Date();
  return Array.from({ length: PERIODS }, (_, i) => {
    const start = new Date(now.getFullYear(), now.getMonth() - (PERIODS - 1) + i, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    return {
      key: localDateKey(start).slice(0, 7),
      label: start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
      short: start.toLocaleDateString(undefined, { month: 'short' }),
      start: start.getTime(),
      end: end.getTime(),
    };
  });
}

function weekBuckets(): Bucket[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Weeks start on Monday.
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return Array.from({ length: PERIODS }, (_, i) => {
    const start = new Date(monday);
    start.setDate(monday.getDate() - (PERIODS - 1 - i) * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    const label = `Week of ${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    return {
      key: localDateKey(start),
      label,
      short: start.toLocaleDateString(undefined, { day: 'numeric', month: 'numeric' }),
      start: start.getTime(),
      end: end.getTime(),
    };
  });
}

/** Commits per bucket for one project. Day keys are local calendar dates ("YYYY-MM-DD"). */
function countsFor(daily: Record<string, number>, buckets: Bucket[]): number[] {
  const counts = new Array<number>(buckets.length).fill(0);
  for (const [day, n] of Object.entries(daily)) {
    const [y, m, d] = day.split('-').map(Number);
    const t = new Date(y!, m! - 1, d!).getTime();
    const i = buckets.findIndex((b) => t >= b.start && t < b.end);
    if (i !== -1) counts[i]! += n;
  }
  return counts;
}

interface Series {
  id: string;
  name: string;
  color: string;
  counts: number[];
  total: number;
}

function readRange(): Range {
  try {
    return localStorage.getItem(RANGE_KEY) === 'weeks' ? 'weeks' : 'months';
  } catch {
    return 'months';
  }
}

export function CommitsByProject({ projects }: { projects: ProjectSummary[] }) {
  const [range, setRange] = useState<Range>(readRange);
  const [focus, setFocus] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const tooltip = useTooltip();

  const { buckets, series, max } = useMemo(() => {
    const months = monthBuckets();
    // Rank by 12-month commits regardless of the visible range: colour follows the project.
    const ranked = projects
      .map((p) => ({
        p,
        yearTotal: countsFor(p.git?.dailyCommits ?? {}, months).reduce((a, b) => a + b, 0),
      }))
      .filter((r) => r.yearTotal > 0)
      .sort((a, b) => b.yearTotal - a.yearTotal);

    const buckets = range === 'months' ? months : weekBuckets();
    const head: Series[] = ranked.slice(0, SERIES_SLOTS).map(({ p }, i) => {
      const counts = countsFor(p.git?.dailyCommits ?? {}, buckets);
      return {
        id: String(p.id),
        name: p.name,
        color: `var(--series-${i + 1})`,
        counts,
        total: counts.reduce((a, b) => a + b, 0),
      };
    });
    const tail = ranked.slice(SERIES_SLOTS);
    const series = [...head];
    if (tail.length > 0) {
      const counts = new Array<number>(buckets.length).fill(0);
      for (const { p } of tail) {
        countsFor(p.git?.dailyCommits ?? {}, buckets).forEach((n, i) => (counts[i]! += n));
      }
      series.push({
        id: 'other',
        name: `Other (${tail.length})`,
        color: 'var(--series-other)',
        counts,
        total: counts.reduce((a, b) => a + b, 0),
      });
    }
    const totals = buckets.map((_, i) => series.reduce((sum, s) => sum + s.counts[i]!, 0));
    return { buckets, series, max: Math.max(1, ...totals) };
  }, [projects, range]);

  const chooseRange = (next: Range) => {
    setRange(next);
    try {
      localStorage.setItem(RANGE_KEY, next);
    } catch {
      // Remembering the choice is a convenience only.
    }
  };

  const legend = [...series].sort((a, b) => b.total - a.total);
  const grandTotal = series.reduce((sum, s) => sum + s.total, 0);

  return (
    <section className="panel" aria-label="Commits by project">
      <div className="panel-header">
        <h2>Commits by project</h2>
        <div className="actions" style={{ alignItems: 'center' }}>
          <div className="segmented" role="radiogroup" aria-label="Time range">
            {(['months', 'weeks'] as const).map((r) => (
              <button
                key={r}
                role="radio"
                aria-checked={range === r}
                className={range === r ? 'is-active' : ''}
                onClick={() => chooseRange(r)}
              >
                {r === 'months' ? '12 months' : '12 weeks'}
              </button>
            ))}
          </div>
          <button
            className="btn btn-sm"
            aria-pressed={showTable}
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? 'Chart' : 'Table'}
          </button>
        </div>
      </div>

      {series.length === 0 ? (
        <p className="faint">No commits in the last 12 months across tracked projects.</p>
      ) : showTable ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Project</th>
                {buckets.map((b) => (
                  <th key={b.key} className="r" title={b.label}>
                    {b.short}
                  </th>
                ))}
                <th className="r">Total</th>
              </tr>
            </thead>
            <tbody>
              {legend.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                      <i className="swatch" style={{ background: s.color }} />
                      {s.name}
                    </span>
                  </td>
                  {s.counts.map((n, i) => (
                    <td key={buckets[i]!.key} className="r faint-zero">
                      {n || '·'}
                    </td>
                  ))}
                  <td className="r">
                    <b>{formatNumber(s.total)}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="stack-chart" aria-hidden="true">
            <div className="stack-grid">
              <span style={{ bottom: '100%' }}>{formatNumber(max)}</span>
              <span style={{ bottom: '50%' }}>{formatNumber(Math.round(max / 2))}</span>
            </div>
            {buckets.map((b, i) => {
              const total = series.reduce((sum, s) => sum + s.counts[i]!, 0);
              const parts = series.filter((s) => s.counts[i]! > 0);
              return (
                <div
                  key={b.key}
                  className="stack-col"
                  onMouseEnter={(e) =>
                    tooltip.show(
                      e,
                      <div className="stack-tip">
                        <b>
                          {b.label}: {formatNumber(total)} commit{total === 1 ? '' : 's'}
                        </b>
                        {[...parts]
                          .sort((x, y) => y.counts[i]! - x.counts[i]!)
                          .map((s) => (
                            <span key={s.id}>
                              <i className="swatch" style={{ background: s.color }} /> {s.name}{' '}
                              {formatNumber(s.counts[i]!)}
                            </span>
                          ))}
                      </div>,
                      e.currentTarget.querySelector('.stack'),
                    )
                  }
                  onMouseLeave={tooltip.hide}
                >
                  <div className="stack" style={{ height: `${(total / max) * 100}%` }}>
                    {/* Bottom-up in legend rank order, so the biggest project sits on the baseline. */}
                    {parts.map((s) => (
                      <span
                        key={s.id}
                        style={{
                          flexGrow: s.counts[i]!,
                          background: s.color,
                          opacity: focus && focus !== s.id ? 0.2 : 1,
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="columns-axis" aria-hidden="true">
            {buckets.map((b) => (
              <span key={b.key}>{b.short}</span>
            ))}
          </div>
          <ul className="stack-legend" aria-label="Projects ranked by commits in this range">
            {legend.map((s) => (
              <li
                key={s.id}
                onMouseEnter={() => setFocus(s.id)}
                onMouseLeave={() => setFocus(null)}
                onFocus={() => setFocus(s.id)}
                onBlur={() => setFocus(null)}
                tabIndex={0}
              >
                <i className="swatch" style={{ background: s.color }} />
                <span className="truncate">{s.name}</span>
                <b className="num">{formatNumber(s.total)}</b>
                <span className="faint num">
                  {grandTotal ? `${Math.round((s.total / grandTotal) * 100)}%` : ''}
                </span>
              </li>
            ))}
          </ul>
          <div className="sr-only">
            <table>
              <caption>Commits by project per {range === 'months' ? 'month' : 'week'}</caption>
              <tbody>
                {legend.map((s) => (
                  <tr key={s.id}>
                    <th scope="row">{s.name}</th>
                    {s.counts.map((n, i) => (
                      <td key={buckets[i]!.key}>
                        {buckets[i]!.label}: {n}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {tooltip.node}
    </section>
  );
}
