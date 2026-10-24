import { expect, it } from 'vitest';
import { parseAntigravityAccounts } from './antigravityAccounts.js';

it('allowlists metadata and converts remaining quota to used quota', () => {
  const state = parseAntigravityAccounts(
    JSON.stringify({
      schema_version: 1,
      command: 'list',
      data: {
        accounts: [
          {
            id: 'acct_test',
            email: 'test@example.com',
            active: true,
            token: 'secret',
            usage: { five_hour: { remaining_percent: 75 }, weekly: { remaining_percent: 0 } },
          },
        ],
      },
    }),
  );
  expect(state.accounts[0]?.usage).toMatchObject({ fiveHour: 25, weekly: 100 });
  expect(JSON.stringify(state)).not.toContain('secret');
});
it('preserves unknown quota rather than reporting zero', () => {
  const state = parseAntigravityAccounts(
    JSON.stringify({
      schema_version: 1,
      command: 'list',
      data: { accounts: [{ id: 'acct_test' }] },
    }),
  );
  expect(state.accounts[0]?.usage.fiveHour).toBeNull();
});
it.each([
  {},
  { schema_version: 2, command: 'list', data: { accounts: [] } },
  { schema_version: 1, command: 'switch', data: { accounts: [] } },
])('rejects unsupported output %j', (output) => {
  expect(() => parseAntigravityAccounts(JSON.stringify(output))).toThrow();
});
