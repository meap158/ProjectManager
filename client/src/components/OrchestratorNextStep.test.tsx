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
