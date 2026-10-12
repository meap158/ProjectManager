import { useEffect, useState } from 'react';
import type { CpuBudget } from '../../../shared/types';
import { api } from '../api';
import { Dropdown } from './Dropdown';

/** Choices: 1, every even count (whole cores with two threads each), and all threads. */
export function budgetChoices(total: number): number[] {
  return Array.from({ length: total }, (_, i) => i + 1).filter(
    (n) => n === 1 || n % 2 === 0 || n === total,
  );
}

function label(n: number, budget: CpuBudget): string {
  if (n === budget.totalThreads) return `All ${n} threads (no limit)`;
  const share = Math.round((n / budget.totalThreads) * 100);
  return `${n} of ${budget.totalThreads} threads (${share}%)${n === budget.defaultThreads ? ' · recommended' : ''}`;
}

/**
 * Settings → CPU budget: how many CPU threads all agent processes may use together, plus
 * below-normal priority. Applies at once to running sessions and runs (server/agents/cpuBudget.ts).
 */
export function CpuBudgetPanel({ onError }: { onError: (message: string) => void }) {
  const [budget, setBudget] = useState<CpuBudget | null>(null);

  useEffect(() => {
    let active = true;
    api.getCpuBudget().then(
      (b) => active && setBudget(b),
      (e: Error) => active && onError(e.message),
    );
    return () => {
      active = false;
    };
  }, [onError]);

  const save = (threads: number) => {
    const before = budget;
    if (before) setBudget({ ...before, threads }); // Optimistic; a failure restores it.
    api.setCpuBudget(threads).then(setBudget, (e: Error) => {
      setBudget(before);
      onError(e.message);
    });
  };

  return (
    <section className="panel" aria-label="CPU budget">
      <div className="panel-header">
        <h2>CPU budget</h2>
        <span className="meta">applies at once to running agents</span>
      </div>
      <p className="faint" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
        Agent CLIs and the builds and tests they start share these CPU threads, at below-normal
        priority, so many agents at once can&rsquo;t hold every core, overheat the machine or slow
        your other apps. A lower budget runs cooler; agents take longer.
      </p>
      {budget === null ? (
        <div className="skeleton" style={{ height: 40 }} />
      ) : !budget.supported ? (
        <p className="faint" style={{ margin: 0 }}>
          Not available on this system: macOS offers no way to limit which CPUs a process uses.
        </p>
      ) : (
        <ul className="list">
          <li className="permission-row">
            <span style={{ flex: 1, minWidth: 0 }}>
              <b>All agents</b>{' '}
              <span className="faint" style={{ fontSize: 12.5 }}>
                — up to {budget.threads} of {budget.totalThreads} threads
              </span>
            </span>
            <Dropdown
              label="CPU threads for all agents"
              value={budget.threads}
              options={budgetChoices(budget.totalThreads).map((n) => ({
                value: n,
                label: label(n, budget),
              }))}
              onChange={(threads: number) => save(threads)}
            />
          </li>
        </ul>
      )}
    </section>
  );
}
