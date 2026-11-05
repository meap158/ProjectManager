// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { OrchestratorConfig, OrchestratorGoal } from '../../../shared/orchestrator';

const goals: OrchestratorGoal[] = [
  {
    id: 1,
    title: 'Ship login',
    objective: 'Users can sign in',
    doneWhen: 'The login e2e test passes on main',
    status: 'active',
    createdAt: '2026-11-06T10:00:00Z',
    updatedAt: '2026-11-06T10:30:00Z',
    progress: [{ at: '2026-11-06T10:30:00Z', note: 'PR #3 open, checks running', by: 'chat' }],
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
  render(<OrchestratorGoals instance={instance} />);
  expect(await screen.findByText('Ship login')).toBeTruthy();
  expect(screen.getByText('The login e2e test passes on main')).toBeTruthy();
  expect(screen.getByText(/PR #3 open/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await waitFor(() =>
    expect(api.updateOrchestratorGoal).toHaveBeenCalledWith('o', 1, { status: 'paused' }),
  );
});

it('adds a goal from the form', async () => {
  render(<OrchestratorGoals instance={instance} />);
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
