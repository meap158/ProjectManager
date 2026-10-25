// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { NativeAccountsPanel } from './AntigravityAccountsPanel';
import type { NativeAccountsState } from '../../../shared/nativeAccounts';

vi.mock('../api', () => ({
  api: {
    getGrokAccounts: vi.fn(),
    refreshGrokAccounts: vi.fn(),
    refreshGrokAccount: vi.fn(),
    saveGrokAccount: vi.fn(),
    importGrokAccount: vi.fn(),
    switchGrokAccount: vi.fn(),
    renameGrokAccount: vi.fn(),
    removeGrokAccount: vi.fn(),
  },
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  localStorage.clear();
});
const account = {
  id: 'grok_' + 'a'.repeat(32),
  name: 'Personal',
  email: 'personal@example.com',
  active: false,
  plan: 'SuperGrok',
  usage: { fiveHour: null, weekly: 37, updatedAt: new Date().toISOString() },
  usageStatus: 'fresh' as const,
  limits: {
    providerId: 'grok',
    source: 'Grok billing service',
    asOf: new Date().toISOString(),
    windows: [
      { label: 'Weekly', windowMinutes: 10080, usedPercent: 37, resetsAt: '2099-01-01T00:00:00Z' },
    ],
  },
};
it('uses the standard account layout, detects default email and refreshes only the requested account', async () => {
  const state: NativeAccountsState = {
    available: true,
    accounts: [],
    defaultAccount: { ...account, active: true },
  };
  vi.mocked(api.getGrokAccounts).mockResolvedValue(state);
  vi.mocked(api.refreshGrokAccount).mockResolvedValue(state);
  render(<NativeAccountsPanel providerId="grok" />);
  await screen.findByText('Default Grok account');
  expect(screen.getByText('active: personal@example.com')).toBeTruthy();
  expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('37');
  expect(document.querySelector('.codex-accounts-panel .codex-account-row')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh usage for default account' }));
  await waitFor(() => expect(api.refreshGrokAccount).toHaveBeenCalledWith('default'));
});
it('requires confirmation for switching and reports unknown usage without a fabricated meter', async () => {
  const state: NativeAccountsState = {
    available: true,
    accounts: [
      {
        ...account,
        limits: null,
        usage: { fiveHour: null, weekly: null, updatedAt: null },
        usageStatus: 'unavailable',
      },
    ],
  };
  vi.mocked(api.getGrokAccounts).mockResolvedValue(state);
  vi.mocked(api.switchGrokAccount).mockResolvedValue({
    ...state,
    accounts: [{ ...state.accounts[0]!, active: true }],
  });
  render(<NativeAccountsPanel providerId="grok" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Switch to account Personal' }));
  expect(api.switchGrokAccount).not.toHaveBeenCalled();
  expect(screen.getByText(/Existing sessions keep their login/)).toBeTruthy();
  expect(screen.queryByRole('meter')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm switch' }));
  await waitFor(() => expect(api.switchGrokAccount).toHaveBeenCalledWith(account.id));
});
