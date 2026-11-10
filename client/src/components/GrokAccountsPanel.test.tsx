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
    setGrokAutoSwitch: vi.fn(),
    setGrokAccountAutoSwitchEligible: vi.fn(),
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
it('shows saved profiles and the live-login explanation together', async () => {
  vi.mocked(api.getGrokAccounts).mockResolvedValue({
    available: true,
    accounts: [account],
    defaultAccount: null,
    authNote: 'Grok is signed out. Saved profiles have not been deleted.',
  });
  render(<NativeAccountsPanel providerId="grok" />);
  expect(
    await screen.findByText('Grok is signed out. Saved profiles have not been deleted.'),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Switch to account Personal' })).toBeTruthy();
  expect(api.switchGrokAccount).not.toHaveBeenCalled();
});
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
it('switches on click like the other switchers and reports unknown usage without a fabricated meter (PM-527)', async () => {
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
  // The heading explains running sessions; one click switches, no second confirmation.
  expect(await screen.findByText(/Existing sessions keep their login/)).toBeTruthy();
  expect(screen.queryByRole('meter')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Switch to account Personal' }));
  await waitFor(() => expect(api.switchGrokAccount).toHaveBeenCalledWith(account.id));
  expect(screen.queryByRole('button', { name: 'Confirm switch' })).toBeNull();
});

it('offers opt-in automatic rotation with an explanation (PM-412)', async () => {
  const state: NativeAccountsState = {
    available: true,
    accounts: [account],
    defaultAccount: { ...account, active: true },
    autoSwitch: false,
  };
  vi.mocked(api.getGrokAccounts).mockResolvedValue(state);
  vi.mocked(api.setGrokAutoSwitch).mockResolvedValue({ ...state, autoSwitch: true });
  render(<NativeAccountsPanel providerId="grok" />);
  const box = (await screen.findByRole('checkbox', {
    name: 'Automatically switch accounts when credits run out',
  })) as HTMLInputElement;
  expect(box.checked).toBe(false);
  fireEvent.click(box);
  await waitFor(() => expect(api.setGrokAutoSwitch).toHaveBeenCalledWith(true));
  await waitFor(() => expect(box.checked).toBe(true));
  expect(screen.getByRole('button', { name: 'How Grok auto-switch works' })).toBeTruthy();
});
it('offers a per-account auto-switch box while automatic switching is on (PM-531)', async () => {
  const saved = { ...account, autoSwitchEligible: false };
  const state: NativeAccountsState = { available: true, accounts: [saved], autoSwitch: true };
  vi.mocked(api.getGrokAccounts).mockResolvedValue(state);
  vi.mocked(api.setGrokAccountAutoSwitchEligible).mockResolvedValue({
    ...state,
    accounts: [account],
  });
  render(<NativeAccountsPanel providerId="grok" />);
  const box = await screen.findByRole('checkbox', {
    name: 'Include Personal in automatic switching',
  });
  expect((box as HTMLInputElement).checked).toBe(false);
  fireEvent.click(box);
  await waitFor(() =>
    expect(api.setGrokAccountAutoSwitchEligible).toHaveBeenCalledWith(account.id, true),
  );
});
it('hides the per-account boxes while automatic switching is off (PM-531)', async () => {
  vi.mocked(api.getGrokAccounts).mockResolvedValue({ available: true, accounts: [account] });
  render(<NativeAccountsPanel providerId="grok" />);
  await screen.findByText('Personal');
  expect(screen.queryByRole('checkbox', { name: /in automatic switching/ })).toBeNull();
});
