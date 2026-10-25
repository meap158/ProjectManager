// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CardWithProject, ProjectSummary } from '../../../shared/types';
import { api } from '../api';
import { BoardPage } from './BoardPage';

const card = (id: number, projectId: number, projectName: string, status: string, title: string) =>
  ({
    id,
    projectId,
    projectName,
    key: `PM-${id}`,
    title,
    description: '',
    status,
    position: 0,
    updatedAt: new Date().toISOString(),
  }) as unknown as CardWithProject;

vi.mock('../api', () => ({
  api: {
    getPermissions: vi.fn(async () => ({ global: 'cli', providers: {} })),
    listAllCards: vi.fn(async () => [
      card(1, 1, 'Alpha', 'todo', 'Plan the release'),
      card(2, 2, 'Beta', 'in_progress', 'Fix login'),
      card(3, 1, 'Alpha', 'done', 'Ship v1'),
    ]),
    listProjects: vi.fn(async () => []),
    listAttachments: vi.fn(async () => []),
    listProviders: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    listRuns: vi.fn(async () => []),
    runSummaries: vi.fn(async () => []),
    updateCard: vi.fn(),
  },
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

const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <BoardPage />
    </MemoryRouter>,
  );

describe('BoardPage', () => {
  it('shows every project’s cards, tagged with their project', async () => {
    renderAt('/board');
    const todo = await screen.findByRole('region', { name: 'To do' });
    expect(within(todo).getByText('Plan the release')).toBeTruthy();
    expect(within(todo).getByText('Alpha')).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'In progress' })).getByText('Beta'),
    ).toBeTruthy();
    expect(screen.getAllByRole('region')).toHaveLength(5);
  });

  it('?show=planned and ?project narrow the board (dashboard links)', async () => {
    renderAt('/board?show=planned');
    await screen.findByText('Plan the release');
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual([
      'Backlog',
      'To do',
    ]);
    cleanup();
    renderAt('/board?project=2');
    await screen.findByText('Fix login');
    expect(screen.queryByText('Plan the release')).toBeNull();
  });

  it('?card=2 automatically opens the card detail dialog', async () => {
    renderAt('/board?card=2');
    await screen.findByText('Fix login');
    expect(await screen.findByText('Edit card')).toBeTruthy();
  });

  it('re-tags a card moved to another project from its dialog (PM-154)', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { id: 1, name: 'Alpha' } as ProjectSummary,
      { id: 2, name: 'Beta' } as ProjectSummary,
    ]);
    vi.mocked(api.updateCard).mockImplementation(
      async (id, patch) =>
        ({
          ...card(1, 1, 'Alpha', 'todo', 'Plan the release'),
          ...patch,
        }) as unknown as CardWithProject,
    );
    renderAt('/board?card=1');
    await screen.findByText('Edit card');
    // The board header carries a "Project" filter of its own, so reach for the one inside the
    // card dialog by its id.
    const picker = document.getElementById('new-card-project')!;
    expect(picker.textContent).toContain('Alpha');
    fireEvent.click(picker);
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Beta'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith(1, expect.objectContaining({ projectId: 2 })),
    );
    // The card is now tagged with the project it moved to, not the one it came from.
    const todo = await screen.findByRole('region', { name: 'To do' });
    await waitFor(() => expect(within(todo).getByText('Beta')).toBeTruthy());
  });

  it('draws the newest 40 Done cards until asked, and every card in the working columns', async () => {
    vi.mocked(api.listAllCards).mockResolvedValueOnce([
      ...Array.from({ length: 45 }, (_, i) => card(100 + i, 1, 'Alpha', 'done', `Done ${i}`)),
      ...Array.from({ length: 45 }, (_, i) => card(200 + i, 1, 'Alpha', 'review', `Review ${i}`)),
    ]);
    renderAt('/board');
    const done = await screen.findByRole('region', { name: 'Done' });
    await waitFor(() => expect(within(done).getAllByText(/^Done \d+$/)).toHaveLength(40));
    expect(within(done).getByText('45')).toBeTruthy(); // The count is still the whole column.
    const review = screen.getByRole('region', { name: 'Review' });
    expect(within(review).getAllByText(/^Review \d+$/)).toHaveLength(45);
    fireEvent.click(within(done).getByRole('button', { name: 'Show 5 older' }));
    expect(within(done).getAllByText(/^Done \d+$/)).toHaveLength(45);
    expect(within(done).queryByRole('button', { name: /older/ })).toBeNull();
  });

  it('filters by title, key or project, with / to focus and Esc to clear (PM-296)', async () => {
    renderAt('/board');
    await screen.findByText('Plan the release');
    fireEvent.keyDown(document.body, { key: '/' });
    const filter = screen.getByRole('searchbox', { name: /Filter cards/ });
    expect(document.activeElement).toBe(filter);
    fireEvent.change(filter, { target: { value: 'beta login' } });
    expect(screen.getByText('Fix login')).toBeTruthy();
    expect(screen.queryByText('Plan the release')).toBeNull();
    fireEvent.change(filter, { target: { value: 'PM-3' } });
    expect(screen.getByText('Ship v1')).toBeTruthy();
    expect(screen.queryByText('Fix login')).toBeNull();
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(screen.getByText('Plan the release')).toBeTruthy();
  });

  it('groups by project, goes compact, and flags In progress past its WIP limit', async () => {
    localStorage.setItem('pm.board.group', 'project');
    localStorage.setItem('pm.board.density', 'compact');
    localStorage.setItem('pm.board.wip', '3');
    vi.mocked(api.listAllCards).mockResolvedValueOnce([
      card(1, 1, 'Alpha', 'in_progress', 'A1'),
      card(2, 2, 'Beta', 'in_progress', 'B1'),
      card(3, 1, 'Alpha', 'in_progress', 'A2'),
      card(4, 2, 'Beta', 'in_progress', 'B2'),
    ]);
    const { container } = renderAt('/board');
    const column = await screen.findByRole('region', { name: 'In progress' });
    await within(column).findByText('A1');
    expect(
      [...column.querySelectorAll('.gcolumn-group-head .truncate')].map((h) => h.textContent),
    ).toEqual(['Alpha', 'Beta']);
    expect(within(column).getByTitle('Over the work-in-progress limit of 3').textContent).toBe(
      '4/3 over',
    );
    expect(container.querySelector('.gboard.is-compact')).toBeTruthy();
  });

  it('shows an old Done card that the filter matches, past the cap', async () => {
    vi.mocked(api.listAllCards).mockResolvedValueOnce(
      Array.from({ length: 45 }, (_, i) => card(100 + i, 1, 'Alpha', 'done', `Done ${i}`)),
    );
    renderAt('/board');
    const done = await screen.findByRole('region', { name: 'Done' });
    await waitFor(() => expect(within(done).queryByText('Done 44')).toBeNull()); // Past the cap.
    fireEvent.change(screen.getByRole('searchbox', { name: /Filter cards/ }), {
      target: { value: 'PM-144' },
    });
    expect(within(done).getByText('Done 44')).toBeTruthy();
    expect(within(done).queryByRole('button', { name: /older/ })).toBeNull();
  });
});
