// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { AgentSession, Card, ProjectSummary } from '../../../shared/types';
import type { OrchestratorState } from '../../../shared/orchestrator';
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
    orchestrators: vi.fn(async () => ({ instances: [], events: [] })),
    tickOrchestrators: vi.fn(async () => ({ instances: [], events: [] })),
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

it('creates a card with no project on the global board as an All projects card (PM-138)', async () => {
  const onCreated = vi.fn();
  render(
    <MemoryRouter>
      <NewCardDialog
        open
        status="backlog"
        projects={[{ id: 1, name: 'Project' } as ProjectSummary]}
        onClose={vi.fn()}
        onCreated={onCreated}
      />
    </MemoryRouter>,
  );
  // The global board offers "All projects", so a title is all a card needs, and the picker
  // says the card can be assigned later.
  expect(screen.getByText(/belongs to no project yet/)).toBeTruthy();
  const create = screen.getByRole('button', { name: 'Create card' });
  expect(create.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Draft' } });
  expect(create.hasAttribute('disabled')).toBe(false);
  fireEvent.click(create);
  await waitFor(() => expect(api.addCard).toHaveBeenCalledOnce());
  expect(api.addCard).toHaveBeenCalledWith(0, {
    title: 'Draft',
    description: '',
    status: 'backlog',
  });
  expect(onCreated).toHaveBeenCalledOnce();
});

it('does not create a card on cancel', () => {
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
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(close).toHaveBeenCalledOnce();
  expect(api.addCard).not.toHaveBeenCalled();
});

it('queues a new card for the project orchestrator and ticks it (PM-142)', async () => {
  vi.mocked(api.orchestrators).mockResolvedValue({
    instances: [{ id: 'orch-1', name: 'All projects', enabled: true, projectIds: [1] }],
    events: [],
  } as unknown as OrchestratorState);
  const onCreated = vi.fn();
  render(
    <MemoryRouter>
      <NewCardDialog open status="backlog" projectId={1} onClose={vi.fn()} onCreated={onCreated} />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Queue me' } });
  fireEvent.click(await screen.findByRole('radio', { name: /Project orchestrator/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Create & queue' }));
  await waitFor(() => expect(api.tickOrchestrators).toHaveBeenCalledWith('orch-1'));
  expect(api.addCard).toHaveBeenCalledWith(1, {
    title: 'Queue me',
    description: '',
    status: 'todo',
  });
  expect(onCreated).toHaveBeenCalledOnce();
});

it('starts from a prefilled title and notes, such as an SOP gap (PM-322)', async () => {
  render(
    <MemoryRouter>
      <NewCardDialog
        open
        status="todo"
        projectId={1}
        initial={{ title: 'SOP: Roadmap', description: 'Found: No ROADMAP.md' }}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    </MemoryRouter>,
  );
  expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('SOP: Roadmap');
  expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe(
    'Found: No ROADMAP.md',
  );
});
