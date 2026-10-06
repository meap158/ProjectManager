// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CardWithProject } from '../../../shared/types';
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
});
