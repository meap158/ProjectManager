// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectSummary } from '../../../shared/types';
import { localDateKey } from './charts';
import { CommitsByProject } from './CommitsByProject';

afterEach(cleanup);

const today = localDateKey(new Date());

/** Minimal project with `commits` commits today. */
function project(id: number, name: string, commits: number): ProjectSummary {
  return {
    id,
    name,
    path: `/code/${name}`,
    git: { dailyCommits: commits ? { [today]: commits } : {} },
  } as unknown as ProjectSummary;
}

const legendRows = () =>
  within(screen.getByRole('list', { name: /ranked by commits/i }))
    .getAllByRole('listitem')
    .map((li) => li.textContent);

describe('CommitsByProject', () => {
  it('ranks projects by commits and folds the tail into "Other"', () => {
    const projects = [
      project(1, 'alpha', 5),
      project(2, 'beta', 50),
      project(3, 'gamma', 1),
      project(4, 'delta', 9),
      project(5, 'eps', 2),
      project(6, 'zeta', 3),
      project(7, 'eta', 4),
      project(8, 'theta', 6),
      project(9, 'idle', 0), // No commits: not shown at all.
    ];
    render(<CommitsByProject projects={projects} />);
    const rows = legendRows();
    // Top 6 by commits get their own entry; gamma (1) and eps (2) fold into Other (2).
    expect(rows[0]).toMatch(/^beta50/);
    expect(rows.some((r) => r?.startsWith('Other (2)3'))).toBe(true);
    expect(rows.some((r) => r?.includes('idle'))).toBe(false);
    expect(rows).toHaveLength(7);
  });

  it('keeps a project on the same colour when switching the range', () => {
    render(<CommitsByProject projects={[project(1, 'alpha', 2), project(2, 'beta', 8)]} />);
    const swatch = (name: string) =>
      (
        within(screen.getByRole('list', { name: /ranked by commits/i })).getByText(name)
          .previousElementSibling as HTMLElement
      ).style.background;
    const before = swatch('alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Time range' }));
    fireEvent.click(within(screen.getByRole('option', { name: /12 weeks/ })).getByRole('button'));
    expect(swatch('alpha')).toBe(before);
  });

  it('offers a table with exact numbers', () => {
    render(<CommitsByProject projects={[project(1, 'alpha', 4)]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    const row = screen.getByRole('row', { name: /alpha/ });
    expect(within(row).getAllByText('4').length).toBeGreaterThan(0);
  });

  it('says so when nothing was committed', () => {
    render(<CommitsByProject projects={[project(1, 'idle', 0)]} />);
    expect(screen.getByText(/no commits in the last 12 months/i)).toBeTruthy();
  });
});
