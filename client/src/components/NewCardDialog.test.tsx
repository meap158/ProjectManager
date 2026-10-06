// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { AgentSession, Card, ProjectSummary } from '../../../shared/types';
import { api } from '../api';
import { NewCardDialog } from './NewCardDialog';

vi.mock('../api', () => ({
  api: {
    getPermissions: vi.fn(async () => ({ global: 'cli', providers: {} })),
    listProviders: vi.fn(async () => [
      { id: 'claude', name: 'Claude Code', binary: 'claude', available: true },
    ]),
    listSessions: vi.fn(async () => [
      { id: 12, name: 'Existing context', providerId: 'claude', status: 'running' },
    ]),
    listRuns: vi.fn(async () => []),
    listAttachments: vi.fn(async () => []),
    addCard: vi.fn(
      async (projectId, input) => ({ id: 9, projectId, key: 'PM-9', ...input }) as Card,
    ),
    attachCardToSession: vi.fn(async () => ({
      session: {} as AgentSession,
      queued: false,
      sent: true,
    })),
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
  vi.clearAllMocks();
  localStorage.clear();
});

it('offers the edit dialog session controls before saving, then creates and sends once', async () => {
  const onCreated = vi.fn();
  render(
    <MemoryRouter>
      <NewCardDialog open status="todo" projectId={1} onClose={vi.fn()} onCreated={onCreated} />
    </MemoryRouter>,
  );
  expect(screen.getByText('Hand to an agent')).toBeTruthy();
  expect(await screen.findByRole('button', { name: /Add images/ })).toBeTruthy();
  fireEvent.click(await screen.findByRole('radio', { name: /Send to a running session/ }));
  expect(screen.getByRole('button', { name: 'Send to session' }).hasAttribute('disabled')).toBe(
    true,
  );
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Implement this' } });
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value: 'Acceptance criteria' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send to session' }));
  await waitFor(() => expect(api.attachCardToSession).toHaveBeenCalledWith(12, 9, true, undefined));
  expect(api.addCard).toHaveBeenCalledOnce();
  expect(api.addCard).toHaveBeenCalledWith(1, {
    title: 'Implement this',
    description: 'Acceptance criteria',
    status: 'todo',
  });
  expect(onCreated).toHaveBeenCalledOnce();
});

it('requires a project on the global board and does not create a card on cancel', async () => {
  const close = vi.fn();
  render(
    <MemoryRouter>
      <NewCardDialog
        open
        status="backlog"
        projects={[{ id: 1, name: 'Project' } as ProjectSummary]}
        onClose={close}
        onCreated={vi.fn()}
      />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Draft' } });
  expect(screen.getByRole('button', { name: 'Create card' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(close).toHaveBeenCalledOnce();
  expect(api.addCard).not.toHaveBeenCalled();
});
