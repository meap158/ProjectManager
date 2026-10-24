// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { AntigravityAccountsPanel } from './AntigravityAccountsPanel';
vi.mock('../api', () => ({
  api: {
    getAntigravityAccounts: vi.fn(),
    refreshAntigravityAccounts: vi.fn(),
    switchAntigravityAccount: vi.fn(),
  },
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('explains missing optional tool without offering account mutations', async () => {
  vi.mocked(api.getAntigravityAccounts).mockResolvedValue({ available: false, accounts: [] });
  render(<AntigravityAccountsPanel />);
  await screen.findByText('Native Antigravity account management is unavailable on this platform.');
  expect(screen.queryByRole('button', { name: 'Switch to account' })).toBeNull();
});
it('requires explicit confirmation before changing the account and explains running sessions', async () => {
  const state = {
    available: true,
    accounts: [
      {
        id: 'acct_test',
        name: 'Backup',
        email: 'test@example.com',
        active: false,
        plan: 'Pro',
        usage: { fiveHour: null, weekly: null, updatedAt: null },
      },
    ],
  };
  vi.mocked(api.getAntigravityAccounts).mockResolvedValue(state);
  vi.mocked(api.switchAntigravityAccount).mockResolvedValue({
    ...state,
    accounts: [{ ...state.accounts[0]!, active: true }],
  });
  render(<AntigravityAccountsPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'Switch to account' }));
  expect(api.switchAntigravityAccount).not.toHaveBeenCalled();
  expect(screen.getByText(/Existing sessions keep their login/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm switch' }));
  await waitFor(() => expect(api.switchAntigravityAccount).toHaveBeenCalledWith('acct_test'));
  await screen.findByText('active');
});
