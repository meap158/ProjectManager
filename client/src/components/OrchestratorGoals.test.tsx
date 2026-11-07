// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { OrchestratorConfig, OrchestratorGoalView } from '../../../shared/orchestrator';

const goals: OrchestratorGoalView[] = [
  {
    id: 1,
    title: 'Ship login',
    objective: 'Users can sign in',
    doneWhen: 'The login e2e test passes on main',
    status: 'active',
    createdAt: '2026-11-06T10:00:00Z',
    updatedAt: '2026-11-06T10:30:00Z',
    progress: [{ at: '2026-11-06T10:30:00Z', note: 'PR #3 open, checks running', by: 'chat' }],
    projects: [],
    cards: [],
    followUp: {
      lastCheckAt: null,
      nextCheckAt: null,
      note: 'No automatic checks: the orchestrator is paused.',
    },
  },
];
vi.mock('../api', () => ({
  api: {
    orchestratorGoals: vi.fn(async () => goals),
    addOrchestratorGoal: vi.fn(async () => goals[0]),
    updateOrchestratorGoal: vi.fn(async () => goals[0]),
    followUpGoal: vi.fn(async () => ({})),
    listAllCards: vi.fn(async () => [
      {
        id: 20,
        key: 'PM-20',
        title: 'Session timeout',
        status: 'todo',
        projectId: 7,
        projectName: 'TiemNet',
        updatedAt: '2026-11-06T09:00:00Z',
      },
    ]),
  },
}));

import { api } from '../api';
import { OrchestratorGoals } from './OrchestratorGoals';

afterEach(cleanup);
const instance = {
  id: 'o',
  name: 'Trial',
  autoCheck: true,
  strategy: 'autonomous',
} as OrchestratorConfig;

it('lists goals with their condition and latest progress, and lets the owner pause one (PM-433)', async () => {
  render(<OrchestratorGoals instance={instance} />, { wrapper: MemoryRouter });
  expect(await screen.findByText('Ship login')).toBeTruthy();
  expect(screen.getByText('The login e2e test passes on main')).toBeTruthy();
  expect(screen.getByText(/PR #3 open/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await waitFor(() =>
    expect(api.updateOrchestratorGoal).toHaveBeenCalledWith('o', 1, { status: 'paused' }),
  );
});

it('adds a goal from the form', async () => {
  render(<OrchestratorGoals instance={instance} />, { wrapper: MemoryRouter });
  fireEvent.click(await screen.findByRole('button', { name: 'Add goal' }));
  fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Release v1' } });
  fireEvent.change(screen.getByLabelText('Objective'), { target: { value: 'Tag and publish' } });
  fireEvent.change(screen.getByLabelText('Done when'), { target: { value: 'v1.0 tag on origin' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start goal' }));
  await waitFor(() =>
    expect(api.addOrchestratorGoal).toHaveBeenCalledWith('o', {
      title: 'Release v1',
      objective: 'Tag and publish',
      doneWhen: 'v1.0 tag on origin',
    }),
  );
});

it('offers Restore for a dropped goal, so Drop can be undone', async () => {
  vi.mocked(api.orchestratorGoals).mockResolvedValueOnce([{ ...goals[0]!, status: 'dropped' }]);
  render(<OrchestratorGoals instance={instance} />, { wrapper: MemoryRouter });
  const restore = await screen.findByRole('button', { name: 'Restore' });
  expect(screen.queryByRole('button', { name: 'Drop' })).toBeNull();
  fireEvent.click(restore);
  await waitFor(() =>
    expect(api.updateOrchestratorGoal).toHaveBeenCalledWith('o', 1, { status: 'active' }),
  );
});

it('shows a goal like an epic: its project, linked cards and how many are done (PM-448)', async () => {
  vi.mocked(api.orchestratorGoals).mockResolvedValue([
    {
      ...goals[0]!,
      projects: [{ id: 7, name: 'TiemNet' }],
      cards: [
        { id: 12, key: 'PM-12', title: 'Login form', status: 'done', projectId: 7 },
        { id: 15, key: 'PM-15', title: 'Login API', status: 'in_progress', projectId: 7 },
      ],
    },
  ]);
  render(<OrchestratorGoals instance={instance} />, { wrapper: MemoryRouter });
  expect(await screen.findByText('TiemNet')).toBeTruthy();
  expect(screen.getByText('1/2')).toBeTruthy();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
  expect(screen.getByRole('link', { name: 'PM-15' }).getAttribute('href')).toBe(
    '/board?project=7&card=15',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Unlink PM-12' }));
  await waitFor(() =>
    expect(api.updateOrchestratorGoal).toHaveBeenCalledWith('o', 1, { unlinkCards: ['PM-12'] }),
  );
  // The picker lists in-scope cards by key and title, with the column and project under each.
  const picker = screen.getByRole('button', { name: 'Link a card to Ship login' });
  await waitFor(() => expect((picker as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(picker);
  fireEvent.click(
    within(await screen.findByRole('option', { name: /PM-20.*Session timeout/ })).getByRole(
      'button',
    ),
  );
  await waitFor(() =>
    expect(api.updateOrchestratorGoal).toHaveBeenCalledWith('o', 1, { linkCards: ['20'] }),
  );
  vi.mocked(api.orchestratorGoals).mockResolvedValue(goals);
});

it('shows who works each card and when the orchestrator follows up, and confirms closing with open cards (PM-454)', async () => {
  const now = Date.now();
  vi.mocked(api.orchestratorGoals).mockResolvedValue([
    {
      ...goals[0]!,
      cards: [
        { id: 12, key: 'PM-12', title: 'Form', status: 'review', projectId: 7 },
        {
          id: 15,
          key: 'PM-15',
          title: 'API',
          status: 'in_progress',
          projectId: 7,
          worker: { kind: 'session', id: 138, name: 'Splash', state: 'running' },
        },
      ],
      followUp: {
        lastCheckAt: new Date(now - 12 * 60_000).toISOString(),
        nextCheckAt: new Date(now + 3 * 60_000 + 20_000).toISOString(),
        note: 'Checks come back to it about every 15 minutes, sooner when its work changes.',
      },
    },
  ]);
  render(<OrchestratorGoals instance={instance} />, { wrapper: MemoryRouter });
  expect(await screen.findByText('Splash')).toBeTruthy();
  expect(screen.getByRole('link', { name: /PM-15/ }).getAttribute('title')).toContain(
    'Session 138 "Splash" is working on it',
  );
  // One follow-up line for the panel: a countdown, the last check and the goals it covers.
  expect(screen.getByRole('timer').textContent).toMatch(
    /Next check in 3:[12][0-9] · last 12 min ago · works on 1 active goal together/,
  );
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: /Mark achieved/ }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: /Mark achieved/ }));
  expect(await screen.findByText('Mark "Ship login" achieved?')).toBeTruthy();
  expect(screen.getByLabelText(/Accept the 1 card in Review as Done/)).toBeTruthy();
  fireEvent.click(
    within(screen.getByRole('dialog', { hidden: true })).getByRole('button', {
      name: 'Mark achieved',
      hidden: true,
    }),
  );
  await waitFor(() =>
    expect(api.updateOrchestratorGoal).toHaveBeenCalledWith('o', 1, {
      status: 'achieved',
      force: true,
      acceptReview: true,
    }),
  );
  vi.mocked(api.orchestratorGoals).mockResolvedValue(goals);
});

it('asks the chat to follow up on one goal now (PM-456)', async () => {
  render(<OrchestratorGoals instance={instance} />, { wrapper: MemoryRouter });
  const button = await screen.findByRole('button', { name: /Follow up/ });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(api.followUpGoal).toHaveBeenCalledWith('o', 1));
  expect(await screen.findByRole('status')).toBeTruthy();
});
