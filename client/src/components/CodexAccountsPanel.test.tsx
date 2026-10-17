// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexAccountsState } from '../../../shared/types';
import { api } from '../api';
import { CodexAccountsPanel } from './CodexAccountsPanel';

vi.mock('../api', () => ({
  api: {
    getCodexAccounts: vi.fn(),
    importCodexAccount: vi.fn(),
    saveCurrentCodexAccount: vi.fn(),
    setActiveCodexAccount: vi.fn(),
    setCodexAutoSwitch: vi.fn(),
    renameCodexAccount: vi.fn(),
    removeCodexAccount: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const baseState: CodexAccountsState = {
  activeProfileId: null,
  autoSwitch: true,
  defaultAccount: {
    available: true,
    email: 'default@example.com',
    plan: 'plus',
    limits: null,
  },
  accounts: [
    {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Work Pro',
      createdAt: '2026-10-17T00:00:00Z',
      email: 'work@example.com',
      plan: 'pro',
      limits: null,
    },
  ],
};

describe('CodexAccountsPanel (PM-164)', () => {
  it('renders default and saved Codex accounts and switches active account', async () => {
    vi.mocked(api.getCodexAccounts).mockResolvedValue(baseState);
    vi.mocked(api.setActiveCodexAccount).mockResolvedValue({
      ...baseState,
      activeProfileId: '11111111-1111-1111-1111-111111111111',
    });

    const onError = vi.fn();
    render(<CodexAccountsPanel onError={onError} />);

    expect(await screen.findByText('Default Codex account')).toBeDefined();
    expect(screen.getByText('Work Pro')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Switch to account' }));
    await waitFor(() =>
      expect(api.setActiveCodexAccount).toHaveBeenCalledWith(
        '11111111-1111-1111-1111-111111111111',
      ),
    );
  });

  it('imports a saved auth.json profile and toggles auto-switch', async () => {
    vi.mocked(api.getCodexAccounts).mockResolvedValue(baseState);
    vi.mocked(api.setCodexAutoSwitch).mockResolvedValue({ ...baseState, autoSwitch: false });
    vi.mocked(api.importCodexAccount).mockResolvedValue({
      ...baseState,
      accounts: [
        ...baseState.accounts,
        {
          id: '22222222-2222-2222-2222-222222222222',
          name: 'Backup Account',
          createdAt: '2026-10-17T01:00:00Z',
        },
      ],
    });

    const onError = vi.fn();
    render(<CodexAccountsPanel onError={onError} />);
    await screen.findByText('Default Codex account');

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Automatically switch accounts when hitting usage limits',
      }),
    );
    await waitFor(() => expect(api.setCodexAutoSwitch).toHaveBeenCalledWith(false));

    fireEvent.click(screen.getByRole('button', { name: 'Import auth.json' }));
    fireEvent.change(screen.getByLabelText('Account name'), {
      target: { value: 'Backup Account' },
    });
    fireEvent.change(screen.getByLabelText('Codex auth.json contents'), {
      target: { value: '{"OPENAI_API_KEY":"sk-backup"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save account' }));

    await waitFor(() =>
      expect(api.importCodexAccount).toHaveBeenCalledWith(
        'Backup Account',
        '{"OPENAI_API_KEY":"sk-backup"}',
      ),
    );
    expect(await screen.findByText('Backup Account')).toBeDefined();
  });
});
