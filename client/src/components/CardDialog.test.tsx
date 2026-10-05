// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { AgentSession, Card } from '../../../shared/types';
import { api } from '../api';
import { CardDialog } from './CardDialog';

vi.mock('../api', () => ({
  api: {
    listProviders: vi.fn(async () => []),
    listSessions: vi.fn(),
    listRuns: vi.fn(async () => []),
    listAttachments: vi.fn(async () => []),
    updateCard: vi.fn(),
    attachCardToSession: vi.fn(),
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
  vi.resetAllMocks();
  localStorage.clear();
});

const card: Card = {
  id: 8,
  projectId: 1,
  key: 'PM-8',
  title: 'Send flow',
  description: 'Original task',
  status: 'todo',
  position: 1000,
  createdAt: '2026-10-05T00:00:00Z',
  updatedAt: '2026-10-05T00:00:00Z',
  closedAt: null,
  linkedCommit: null,
};
function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}
async function openDialog() {
  const onClose = vi.fn();
  const onDispatched = vi.fn();
  vi.mocked(api.listSessions).mockResolvedValue([
    { id: 12, providerId: 'claude', status: 'running', name: 'Existing context' } as AgentSession,
  ]);
  vi.mocked(api.updateCard).mockImplementation(async (_id, patch) => ({ ...card, ...patch }));
  render(
    <MemoryRouter initialEntries={['/board']}>
      <Location />
      <CardDialog
        card={card}
        projectId={1}
        onClose={onClose}
        onDispatched={onDispatched}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('radio', { name: /Send to a running session/ }));
  return { onClose, onDispatched };
}

it('saves edits and automatically sends the card while staying on the board', async () => {
  const { onClose, onDispatched } = await openDialog();
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Updated task' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send to session' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(api.updateCard).toHaveBeenCalledWith(8, {
    title: 'Send flow',
    description: 'Updated task',
  });
  expect(api.attachCardToSession).toHaveBeenCalledWith(12, 8, true, undefined);
  expect(onDispatched).toHaveBeenCalledOnce();
  expect(screen.getByTestId('location').textContent).toBe('/board');
});

it('keeps the dialog open and shows submission errors for retry', async () => {
  const { onClose, onDispatched } = await openDialog();
  vi.mocked(api.attachCardToSession).mockRejectedValue(new Error('Session unavailable'));
  fireEvent.click(screen.getByRole('button', { name: 'Send to session' }));
  await screen.findByText('Session unavailable');
  expect(onClose).not.toHaveBeenCalled();
  expect(onDispatched).not.toHaveBeenCalled();
  expect(screen.getByTestId('location').textContent).toBe('/board');
});
