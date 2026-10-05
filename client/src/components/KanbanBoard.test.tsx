// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Card } from '../../../shared/types';
import { api } from '../api';
import { KanbanBoard } from './KanbanBoard';

vi.mock('../api', () => ({
  api: {
    listCards: vi.fn(),
    runSummaries: vi.fn(async () => []),
    updateCard: vi.fn(),
    addCard: vi.fn(),
    listProviders: vi.fn(async () => []),
    listRuns: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
  },
}));

beforeAll(() => {
  // jsdom has no modal dialog support; the board's card dialog only needs open/close.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const card = (id: number, projectId: number, title: string, status: Card['status']): Card => ({
  id,
  projectId,
  key: `PM-${id}`,
  title,
  description: '',
  status,
  position: id * 1000,
  createdAt: '2026-10-05T00:00:00Z',
  updatedAt: '2026-10-05T00:00:00Z',
  closedAt: null,
  linkedCommit: null,
});

// Each test uses its own project id: the board caches cards per project at module scope.
function renderBoard(projectId: number, cards: Card[]) {
  vi.mocked(api.listCards).mockResolvedValue(cards);
  render(
    <MemoryRouter>
      <KanbanBoard projectId={projectId} reloadKey={0} />
    </MemoryRouter>,
  );
}
const column = (name: string) => screen.getByRole('region', { name });

describe('KanbanBoard', () => {
  it('shows each card in its column', async () => {
    renderBoard(1, [card(1, 1, 'Plan it', 'backlog'), card(2, 1, 'Ship it', 'review')]);
    await screen.findByText('Plan it');
    expect(within(column('Backlog')).getByText('Plan it')).toBeTruthy();
    expect(within(column('Review')).getByText('Ship it')).toBeTruthy();
  });

  it('moves a card by drag and drop and saves the new column', async () => {
    renderBoard(2, [card(3, 2, 'Drag me', 'backlog')]);
    vi.mocked(api.updateCard).mockImplementation(async (id, patch) => ({
      ...card(3, 2, 'Drag me', 'backlog'),
      ...patch,
    }));
    const item = (await screen.findByText('Drag me')).closest('button')!;
    const dataTransfer = { setData: () => undefined, effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(item, { dataTransfer });
    fireEvent.dragOver(column('Done'), { dataTransfer });
    fireEvent.drop(column('Done'), { dataTransfer });
    await waitFor(() => expect(within(column('Done')).getByText('Drag me')).toBeTruthy());
    expect(api.updateCard).toHaveBeenCalledWith(3, expect.objectContaining({ status: 'done' }));
  });

  it('adds a card to the chosen column with quick add', async () => {
    renderBoard(3, []);
    vi.mocked(api.addCard).mockImplementation(async (_projectId, input) =>
      card(9, 3, input.title, input.status),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add card to To do' }));
    fireEvent.change(screen.getByLabelText('New card title'), { target: { value: 'New idea' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(within(column('To do')).getByText('New idea')).toBeTruthy());
    expect(api.addCard).toHaveBeenCalledWith(3, { title: 'New idea', status: 'todo' });
  });

  it('changes the column from the card dialog (keyboard alternative to dragging)', async () => {
    renderBoard(4, [card(5, 4, 'Edit me', 'todo')]);
    vi.mocked(api.updateCard).mockImplementation(async (id, patch) => ({
      ...card(5, 4, 'Edit me', 'todo'),
      ...patch,
    }));
    fireEvent.click((await screen.findByText('Edit me')).closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Column' }));
    fireEvent.click(
      within(screen.getByRole('option', { name: /In progress/ })).getByRole('button'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateCard).toHaveBeenCalledWith(
        5,
        expect.objectContaining({ status: 'in_progress' }),
      ),
    );
    await waitFor(() => expect(within(column('In progress')).getByText('Edit me')).toBeTruthy());
  });
});
