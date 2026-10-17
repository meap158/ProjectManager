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
afterEach(cleanup);

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
});
