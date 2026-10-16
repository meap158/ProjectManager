// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it } from 'vitest';
import { OrchestratorProviderRecovery } from './OrchestratorProviderRecovery';
afterEach(cleanup);
it('offers distinct recovery actions for mixed provider blockers', () => {
  render(
    <MemoryRouter>
      <OrchestratorProviderRecovery
        blocker={{ providerId: 'claude', code: 'unavailable', detail: 'CLI missing' }}
      />
      <OrchestratorProviderRecovery
        blocker={{ providerId: 'codex', code: 'quota_reserve', detail: 'Reserve reached' }}
      />
      <OrchestratorProviderRecovery
        blocker={{ providerId: 'opencode', code: 'capacity', detail: 'Workers busy' }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'Agent settings' }).getAttribute('href')).toBe(
    '/settings',
  );
  expect(screen.getByRole('link', { name: 'View usage' }).getAttribute('href')).toBe('/agents');
  expect(screen.getByRole('link', { name: 'View workers' }).getAttribute('href')).toBe('/agents');
});
it('preserves older blocker details without guessing recovery from text', () => {
  render(
    <MemoryRouter>
      <OrchestratorProviderRecovery
        blocker={{ providerId: 'codex', detail: 'Authentication unavailable' }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText('Authentication unavailable')).toBeDefined();
  expect(screen.queryByRole('link')).toBeNull();
});
