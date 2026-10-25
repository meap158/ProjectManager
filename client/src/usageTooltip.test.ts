import { expect, it } from 'vitest';
import { usageTooltip } from './usageTooltip';
it('shows account identity, plan and provenance without changing the compact badge', () => {
  const text = usageTooltip({
    providerId: 'codex',
    accountEmail: 'active@example.com',
    accountName: 'Work',
    accountPlan: 'plus',
    source: 'account service',
    asOf: new Date().toISOString(),
    windows: [],
  });
  expect(text).toContain('Active account: active@example.com');
  expect(text).toContain('Plan: plus');
  expect(text).toContain('From the account service, reported');
});
it('does not imply a missing email means signed out', () => {
  expect(
    usageTooltip({
      providerId: 'grok',
      source: 'billing',
      asOf: new Date().toISOString(),
      windows: [],
    }),
  ).toContain('Active account: email unavailable');
});
