// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '../../../shared/types';
import { api } from '../api';
import { ProjectsPage } from './ProjectsPage';

vi.mock('../api', () => ({
  api: { listProjects: vi.fn(), listCardsInFlight: vi.fn(async () => []) },
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const counts = { backlog: 0, todo: 0, in_progress: 0, review: 0, done: 0 };
function project(
  id: number,
  name: string,
  firstCommitAt: string | null,
  lines: number,
): ProjectSummary {
  return {
    id,
    name,
    path: `/code/${name}`,
    missing: false,
    scan: { status: 'idle', error: null, startedAt: null, moves: [] },
    cardCounts: counts,
    code: { code: lines, languages: [] },
    disk: { bytes: lines * 10 },
    git: firstCommitAt
      ? {
          isRepo: true,
          totalCommits: 3,
          firstCommitAt,
          lastCommitAt: firstCommitAt,
          dailyCommits: {},
        }
      : null,
  } as unknown as ProjectSummary;
}

async function renderRankings() {
  vi.mocked(api.listProjects).mockResolvedValue([
    project(1, 'middle', '2026-08-01T00:00:00Z', 100),
    project(2, 'newest', '2026-10-01T00:00:00Z', 50),
    project(3, 'unscanned', null, 10),
    project(4, 'oldest', '2026-06-01T00:00:00Z', 900),
  ]);
  render(
    <MemoryRouter>
      <ProjectsPage />
    </MemoryRouter>,
  );
  return screen.findByRole('region', { name: 'Project rankings' });
}
const order = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.querySelectorAll('td')[1]!.textContent);

describe('Rankings table', () => {
  it('sorts by first commit both ways, with projects lacking history always last', async () => {
    const table = await renderRankings();
    const header = within(table).getByRole('columnheader', { name: /First commit/ });
    const sortButton = within(header).queryByRole('button') ?? header;

    fireEvent.click(sortButton); // Natural direction: newest project first.
    expect(order(table)).toEqual(['newest', 'middle', 'oldest', 'unscanned']);
    expect(header.textContent).toContain('↓');

    fireEvent.click(sortButton); // Reversed: oldest first, unscanned still last.
    expect(order(table)).toEqual(['oldest', 'middle', 'newest', 'unscanned']);
    expect(header.textContent).toContain('↑');
  });

  it('follows the arrow on numeric columns (largest first when ↓)', async () => {
    const table = await renderRankings();
    // Default sort is Lines ↓.
    expect(order(table)).toEqual(['oldest', 'middle', 'newest', 'unscanned']);
  });
});
