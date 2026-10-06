// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '../../../shared/types';
import { useBoardView } from '../boardView';
import { BoardListView, BoardViewTabs } from './BoardListView';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const card = (id: number, title: string, status: Card['status']): Card => ({
  id,
  projectId: 1,
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

const CARDS = [
  card(1, 'Plan it', 'todo'),
  card(2, 'Build it', 'in_progress'),
  card(3, 'Shipped', 'done'),
];

function renderList(onOpen = vi.fn(), onAdd = vi.fn(), onToggleDone = vi.fn()) {
  render(
    <BoardListView
      columns={['todo', 'in_progress', 'done']}
      cards={CARDS}
      onOpen={onOpen}
      onAdd={onAdd}
      meta={(c) => <span>{c.key}</span>}
      onToggleDone={onToggleDone}
    />,
  );
  return { onOpen, onAdd, onToggleDone };
}
const group = (name: string) => screen.getByRole('region', { name });
// The group header's disclosure button (it's named by the status pill and count).
const toggle = (name: string) => within(group(name)).getAllByRole('button')[0]!;

describe('BoardListView', () => {
  it('groups cards by status with counts, Done collapsed at first', () => {
    renderList();
    expect(within(group('To do')).getByText('Plan it')).toBeTruthy();
    expect(within(group('In progress')).getByText('Build it')).toBeTruthy();
    expect(toggle('Done').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Shipped')).toBeNull();
    expect(within(group('Done')).getByText('1')).toBeTruthy();
  });

  it('expands and collapses groups, and remembers it', () => {
    renderList();
    fireEvent.click(toggle('Done'));
    expect(screen.getByText('Shipped')).toBeTruthy();
    fireEvent.click(toggle('To do'));
    expect(screen.queryByText('Plan it')).toBeNull();
    cleanup();
    renderList();
    expect(screen.getByText('Shipped')).toBeTruthy();
    expect(screen.queryByText('Plan it')).toBeNull();
  });

  it('opens a card from its row and adds to a group from + or New', () => {
    const { onOpen, onAdd } = renderList();
    fireEvent.click(screen.getByText('Build it'));
    expect(onOpen).toHaveBeenCalledWith(CARDS[1]);
    fireEvent.click(screen.getByRole('button', { name: 'New card in To do' }));
    expect(onAdd).toHaveBeenLastCalledWith('todo');
    fireEvent.click(screen.getByRole('button', { name: 'Add a card to In progress' }));
    expect(onAdd).toHaveBeenLastCalledWith('in_progress');
  });

  it('ticks a card done from its checkbox, and unticks a done card (PM-48)', () => {
    const { onOpen, onToggleDone } = renderList();
    const plan = screen.getByRole('checkbox', { name: 'Mark done: Plan it' });
    expect(plan.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(plan);
    expect(onToggleDone).toHaveBeenLastCalledWith(CARDS[0], true);
    expect(onOpen).not.toHaveBeenCalled(); // The checkbox doesn't open the card.
    fireEvent.click(toggle('Done'));
    const shipped = screen.getByRole('checkbox', { name: /Done: Shipped/ });
    expect(shipped.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(shipped);
    expect(onToggleDone).toHaveBeenLastCalledWith(CARDS[2], false);
  });
});

function Tabs() {
  const [view, setView] = useBoardView();
  return (
    <>
      <BoardViewTabs view={view} onChange={setView} />
      <output>{view}</output>
    </>
  );
}

describe('BoardViewTabs', () => {
  it('defaults to the Kanban board and remembers the List choice', () => {
    render(<Tabs />);
    expect(screen.getByRole('radio', { name: 'Board' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(screen.getByRole('status').textContent).toBe('list');
    cleanup();
    render(<Tabs />);
    expect(screen.getByRole('radio', { name: 'List' }).getAttribute('aria-checked')).toBe('true');
  });
});
