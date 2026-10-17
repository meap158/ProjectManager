// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { AgentSession, Card, ProjectSummary } from '../../../shared/types';
import { api } from '../api';
import { CardDialog } from './CardDialog';

vi.mock('../api', () => ({
  api: {
    getPermissions: vi.fn(async () => ({ global: 'cli', providers: {} })),
    listProviders: vi.fn(async () => []),
    listSessions: vi.fn(),
    listRuns: vi.fn(async () => []),
    createSession: vi.fn(),
    listAttachments: vi.fn(async () => []),
    updateCard: vi.fn(),
    addCard: vi.fn(),
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
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
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

it('remembers the CLI chosen to hand a card to (PM-8)', async () => {
  localStorage.setItem('pm.card.provider', 'codex');
  vi.mocked(api.listProviders).mockResolvedValue([
    { id: 'claude', name: 'Claude Code', binary: 'claude', available: true },
    { id: 'codex', name: 'Codex', binary: 'codex', available: true },
  ] as Awaited<ReturnType<typeof api.listProviders>>);
  await openDialog();
  fireEvent.click(screen.getByRole('radio', { name: /Task session/ }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Agent' }).textContent).toContain('Codex'),
  );
});

it('starts a non-supervised interactive task session and opens its terminal', async () => {
  localStorage.setItem('pm.card.provider', 'codex');
  vi.mocked(api.listProviders).mockResolvedValue([
    { id: 'codex', name: 'Codex', binary: 'codex', available: true },
  ] as Awaited<ReturnType<typeof api.listProviders>>);
  vi.mocked(api.createSession).mockResolvedValue({ id: 93 } as AgentSession);
  await openDialog();
  fireEvent.click(screen.getByRole('radio', { name: /Task session/ }));
  fireEvent.change(screen.getByLabelText('Custom task for the agent (optional)'), {
    target: { value: 'Finish the task and summarize the result.' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Open task session' }));
  await waitFor(() =>
    expect(api.createSession).toHaveBeenCalledWith(1, {
      providerId: 'codex',
      cardId: 8,
      terminal: 'pty',
      supervise: false,
      prompt: 'Finish the task and summarize the result.',
    }),
  );
  await waitFor(() =>
    expect(screen.getByTestId('location').textContent).toBe('/workspace?open=93'),
  );
});

const projects = [
  { id: 1, name: 'Project Alpha' },
  { id: 2, name: 'Project Beta' },
] as ProjectSummary[];

/** Opens the Project picker and clicks one of its entries. */
async function chooseProject(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Project' }));
  fireEvent.click(within(screen.getByRole('listbox')).getByText(name));
}

it('edits a card onto another project from a project board (PM-154)', async () => {
  vi.mocked(api.listSessions).mockResolvedValue([]);
  vi.mocked(api.updateCard).mockImplementation(async (_id, patch) => ({ ...card, ...patch }));
  const onSaved = vi.fn();
  render(
    <MemoryRouter>
      <CardDialog
        card={card}
        projectId={1}
        projects={projects}
        onClose={vi.fn()}
        onSaved={onSaved}
        onDeleted={vi.fn()}
      />
    </MemoryRouter>,
  );
  // The picker is on screen for a card that already has a project, opened on that project.
  const picker = await screen.findByRole('button', { name: 'Project' });
  expect(picker.textContent).toContain('Project Alpha');
  await chooseProject('Project Beta');
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Send flow mk2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(api.updateCard).toHaveBeenCalledWith(8, {
    title: 'Send flow mk2',
    description: 'Original task',
    projectId: 2,
  });
});

it('creates a card in the project picked on a project board (PM-154)', async () => {
  vi.mocked(api.listSessions).mockResolvedValue([]);
  vi.mocked(api.addCard).mockImplementation(
    async (projectId, input) => ({ id: 9, projectId, key: 'PM-9', ...input }) as Card,
  );
  const onSaved = vi.fn();
  render(
    <MemoryRouter>
      <CardDialog
        card={{ ...card, id: 0, projectId: 1, title: '', description: '' }}
        projectId={1}
        projects={projects}
        creating
        onClose={vi.fn()}
        onSaved={onSaved}
        onDeleted={vi.fn()}
      />
    </MemoryRouter>,
  );
  const picker = await screen.findByRole('button', { name: 'Project' });
  expect(picker.textContent).toContain('Project Alpha');
  await chooseProject('Project Beta');
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Beta work' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create card' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(api.addCard).toHaveBeenCalledWith(2, {
    title: 'Beta work',
    description: '',
    status: 'todo',
  });
});
