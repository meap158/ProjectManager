// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it } from 'vitest';
import { OrchestratorNextStep } from './OrchestratorNextStep';
import type { OrchestratorPlanDecision } from '../../../shared/orchestrator';
afterEach(cleanup);
function show(
  waitReason: OrchestratorPlanDecision['waitReason'],
  action: OrchestratorPlanDecision['action'] = 'wait',
) {
  render(
    <MemoryRouter>
      <OrchestratorNextStep
        decision={{ cardId: 4, projectId: 7, action, reason: 'Blocked', waitReason }}
      />
    </MemoryRouter>,
  );
}
it('links review to the scoped run list', () => {
  show('review_required', 'review');
  expect(screen.getByRole('link', { name: 'Review runs' }).getAttribute('href')).toBe(
    '/projects/7?tab=agents',
  );
});
it('explains quota verification after renewal without sending a message', () => {
  show('quota_exceeded');
  expect(screen.getByText(/after renewal, check the queue/)).toBeDefined();
  expect(screen.getByRole('link', { name: 'View usage' }).getAttribute('href')).toBe('/agents');
});
it('directs unavailable CLI recovery to settings', () => {
  show('no_provider_available');
  expect(screen.getByRole('link').getAttribute('href')).toBe('/settings');
});
it('keeps ready decisions compact', () => {
  show(undefined, 'dispatch');
  expect(screen.queryByRole('link')).toBeNull();
});

it('directs cooldown recovery to the task without bypassing its waiting period', () => {
  show('retry_cooldown');
  expect(screen.getByText(/Wait until the cooldown ends/)).toBeDefined();
  expect(screen.getByRole('link', { name: 'Open task' }).getAttribute('href')).toBe(
    '/board?project=7&card=4',
  );
});
it('directs exhausted budgets to failed-run inspection', () => {
  show('retry_budget_exhausted');
  expect(screen.getByText(/correct the cause before requesting more work/)).toBeDefined();
  expect(screen.getByRole('link', { name: 'Inspect runs' }).getAttribute('href')).toBe(
    '/projects/7?tab=agents',
  );
});

it('opens an owned review in its Orchestrator workspace', () => {
  render(
    <MemoryRouter>
      <OrchestratorNextStep
        decision={{
          cardId: 4,
          projectId: 7,
          action: 'review',
          reason: 'Review',
          waitReason: 'review_required',
          worker: { runId: 9, orchestratorId: 'master' },
        }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'Review runs' }).getAttribute('href')).toBe(
    '/orchestrators?orchestrator=master&run=9#orchestrator-runs-master',
  );
});

it.each(['active', 'unknown'] as const)(
  'opens the owning worker for %s execution',
  (executionState) => {
    render(
      <MemoryRouter>
        <OrchestratorNextStep
          decision={{
            cardId: 4,
            projectId: 7,
            action: 'wait',
            reason: 'Worker',
            waitReason: 'active_worker',
            worker: { runId: 9, orchestratorId: 'actual-owner', executionState },
          }}
        />
      </MemoryRouter>,
    );
    expect(
      screen
        .getByRole('link', {
          name: executionState === 'unknown' ? 'Inspect unknown execution' : 'View workers',
        })
        .getAttribute('href'),
    ).toBe('/orchestrators?orchestrator=actual-owner&run=9#orchestrator-runs-actual-owner');
    if (executionState === 'unknown')
      expect(screen.getByText(/independently verifying it has stopped/)).toBeDefined();
  },
);

it('links cooldown inspection to its worker without offering an immediate retry', () => {
  render(
    <MemoryRouter>
      <OrchestratorNextStep
        decision={{
          cardId: 4,
          projectId: 7,
          action: 'wait',
          reason: 'Cooldown',
          waitReason: 'retry_cooldown',
          worker: { runId: 9, orchestratorId: 'actual-owner' },
        }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'Inspect failed run' }).getAttribute('href')).toBe(
    '/orchestrators?orchestrator=actual-owner&run=9#orchestrator-runs-actual-owner',
  );
  expect(screen.getByText(/does not bypass the cooldown/)).toBeDefined();
  expect(screen.queryByRole('button')).toBeNull();
});
