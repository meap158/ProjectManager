// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  },
];
vi.mock('../api', () => ({
  api: {
    orchestratorGoals: vi.fn(async () => goals),
    addOrchestratorGoal: vi.fn(async () => goals[0]),
    updateOrchestratorGoal: vi.fn(async () => goals[0]),
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
  expect(screen.getByText('1 of 2 cards done')).toBeTruthy();
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
  expect(screen.getByRole('link', { name: 'PM-15' }).getAttribute('href')).toBe(
    '/board?project=7&card=15',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Unlink PM-12' }));
  await waitFor(() =>
    expect(api.updateOrchestratorGoal).toHaveBeenCalledWith('o', 1, { unlinkCards: ['PM-12'] }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Link cards' }));
  fireEvent.change(screen.getByLabelText('Cards to link to Ship login'), {
    target: { value: 'PM-20, PM-21' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Link' }));
  await waitFor(() =>
    expect(api.updateOrchestratorGoal).toHaveBeenCalledWith('o', 1, {
      linkCards: ['PM-20', 'PM-21'],
    }),
  );
  vi.mocked(api.orchestratorGoals).mockResolvedValue(goals);
});
