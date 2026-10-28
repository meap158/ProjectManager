// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexAccountsState } from '../../../shared/types';
import { api } from '../api';
import { SettingsPage } from '../pages/SettingsPage';
import { MemoryRouter } from 'react-router';
import { CodexAccountsPanel } from './CodexAccountsPanel';

vi.mock('../agentLimits', () => ({
  useAgentLimits: () => ({ list: [], now: 0 }),
}));
vi.mock('./AgentPermissionsPanel', () => ({
  AgentPermissionsPanel: () => null,
}));
vi.mock('./CpuBudgetPanel', () => ({
  CpuBudgetPanel: () => null,
}));
vi.mock('./LanAccessPanel', () => ({
  LanAccessPanel: () => null,
}));
vi.mock('./RemoteAccessPanel', () => ({
  RemoteAccessPanel: () => null,
}));

vi.mock('../api', () => ({
  api: {
    listProviders: vi.fn(),
    listProvidersRefresh: vi.fn(),
    listInstalls: vi.fn(),
    listProjects: vi.fn(),
    getCodexAccounts: vi.fn(),
    getCodexAccountsRefreshing: vi.fn(),
    refreshCodexAccountsUsage: vi.fn(),
    refreshCodexAccountUsage: vi.fn(),
    importCodexAccount: vi.fn(),
    saveCurrentCodexAccount: vi.fn(),
    setActiveCodexAccount: vi.fn(),
    setCodexAutoSwitch: vi.fn(),
    setCodexAccountOrder: vi.fn(),
    setCodexAccountAutoSwitchEligible: vi.fn(),
    renameCodexAccount: vi.fn(),
    removeCodexAccount: vi.fn(),
    getClaudeAccounts: vi.fn(),
    importClaudeAccount: vi.fn(),
    saveCurrentClaudeAccount: vi.fn(),
    setActiveClaudeAccount: vi.fn(),
    setClaudeAutoSwitch: vi.fn(),
    renameClaudeAccount: vi.fn(),
    removeClaudeAccount: vi.fn(),
  },
}));

beforeEach(() => {
  // The panel's first load also asks for a background usage refresh (PM-173); tests set
  // the state through getCodexAccounts.
  vi.mocked(api.getCodexAccountsRefreshing).mockImplementation(() => api.getCodexAccounts());
});
afterEach(() => {
  cleanup();
  localStorage.clear();
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
  it('uses the standard refresh controls for Claude without calling Codex usage', async () => {
    vi.mocked(api.getClaudeAccounts).mockResolvedValue(baseState);
    render(<CodexAccountsPanel providerId="claude" onError={vi.fn()} />);
    await screen.findByText('Default Claude account');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage for Work Pro' }));
    await waitFor(() => expect(api.getClaudeAccounts).toHaveBeenCalledTimes(2));
    expect(api.refreshCodexAccountUsage).not.toHaveBeenCalled();
    expect(api.refreshCodexAccountsUsage).not.toHaveBeenCalled();
  });
  it('refreshes only the requested account and remembers reordered rows', async () => {
    const state = {
      ...baseState,
      accounts: [
        ...baseState.accounts,
        { ...baseState.accounts[0]!, id: '22222222-2222-2222-2222-222222222222', name: 'Personal' },
      ],
    };
    vi.mocked(api.getCodexAccounts).mockResolvedValue(state);
    vi.mocked(api.refreshCodexAccountUsage).mockResolvedValue(state);
    const reordered = { ...state, accounts: [state.accounts[1]!, state.accounts[0]!] };
    vi.mocked(api.setCodexAccountOrder).mockResolvedValue(reordered);
    const first = render(<CodexAccountsPanel onError={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh usage for Work Pro' }));
    await waitFor(() =>
      expect(api.refreshCodexAccountUsage).toHaveBeenCalledWith(state.accounts[0]!.id),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Refresh usage for Work Pro' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reorder accounts' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Personal' }), { key: 'ArrowUp' });
    const names = () =>
      [...document.querySelectorAll('.codex-accounts-list > li .codex-account-info b')].map(
        (el) => el.textContent,
      );
    expect(names()).toEqual(['Default Codex account', 'Personal', 'Work Pro']);
    // Auto-switch breaks ties by this order, so the server gets it too.
    await waitFor(() =>
      expect(api.setCodexAccountOrder).toHaveBeenCalledWith(reordered.accounts.map((a) => a.id)),
    );
    first.unmount();
    // The server now holds the order, and every device shows it.
    vi.mocked(api.getCodexAccounts).mockResolvedValue(reordered);
    render(<CodexAccountsPanel onError={vi.fn()} />);
    await screen.findByText('Personal');
    expect(names()).toEqual(['Default Codex account', 'Personal', 'Work Pro']);
  });
  it('explains how auto-switch picks an account', async () => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    vi.mocked(api.getCodexAccounts).mockResolvedValue(baseState);
    render(<CodexAccountsPanel onError={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'How auto-switch works' }));
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
    expect(screen.getByText(/most 5-hour quota left/)).toBeDefined();
    expect(screen.getByText(/stays on the current one/)).toBeDefined();
  });
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

    fireEvent.click(screen.getByRole('button', { name: 'Switch to account Work Pro' }));
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

  it('expands Codex account switching inside the Codex entry in Settings > Agent CLIs (PM-168)', async () => {
    vi.mocked(api.listProviders).mockResolvedValue([
      {
        id: 'claude',
        name: 'Claude Code',
        description: 'Anthropic coding CLI',
        binary: 'claude',
        argsTemplate: [],
        available: true,
        resolvedPath: 'claude',
        install: null,
      },
      {
        id: 'codex',
        name: 'Codex',
        description: 'OpenAI coding CLI',
        binary: 'codex',
        argsTemplate: [],
        available: true,
        resolvedPath: 'codex',
        install: null,
      },
    ]);
    vi.mocked(api.listInstalls).mockResolvedValue([]);
    vi.mocked(api.listProjects).mockResolvedValue([]);
    vi.mocked(api.getCodexAccounts).mockResolvedValue(baseState);

    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    const cliSection = await screen.findByRole('region', { name: 'Agent CLIs' });
    const expandButtons = await within(cliSection).findAllByRole('button', { name: 'Accounts' });
    expect(expandButtons).toHaveLength(2);
    const [claudeExpandBtn, codexExpandBtn] = expandButtons as [HTMLElement, HTMLElement];
    expect(codexExpandBtn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Codex accounts' })).toBeNull();

    fireEvent.click(codexExpandBtn);
    expect(codexExpandBtn.getAttribute('aria-expanded')).toBe('true');

    const codexRegion = await within(cliSection).findByRole('region', { name: 'Codex accounts' });
    expect(await within(codexRegion).findByText('Default Codex account')).toBeDefined();
    expect(within(codexRegion).getByText('Work Pro')).toBeDefined();

    vi.mocked(api.getClaudeAccounts).mockResolvedValue(baseState);
    fireEvent.click(claudeExpandBtn);
    expect(claudeExpandBtn.getAttribute('aria-expanded')).toBe('true');
    const claudeRegion = await within(cliSection).findByRole('region', { name: 'Claude accounts' });
    expect(await within(claudeRegion).findByText('Default Claude account')).toBeDefined();
  });

  it('deduplicates account name when it equals email, shows saved timestamp, and offers Add nickname (PM-169, PM-173)', async () => {
    vi.mocked(api.getCodexAccounts).mockResolvedValue({
      ...baseState,
      accounts: [
        {
          id: '33333333-3333-3333-3333-333333333333',
          name: 'dup@example.com',
          email: 'dup@example.com',
          plan: 'plus',
          createdAt: '2026-10-17T12:00:00Z',
          limits: null,
        },
      ],
    });

    render(<CodexAccountsPanel onError={vi.fn()} />);
    expect(await screen.findByText('dup@example.com')).toBeDefined();
    expect(screen.queryByText(/· dup@example\.com/)).toBeNull();
    expect(screen.getByText(/· saved /)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Rename dup@example.com' }).textContent).toBe(
      'Add nickname',
    );
  });
});

it('refreshes account usage without switching accounts and displays expired login state', async () => {
  vi.mocked(api.getCodexAccounts).mockResolvedValue(baseState);
  vi.mocked(api.refreshCodexAccountsUsage).mockResolvedValue({
    ...baseState,
    accounts: baseState.accounts.map((a) => ({ ...a, usageStatus: 'expired' })),
  });
  render(<CodexAccountsPanel onError={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh usage' }));
  expect(await screen.findByText(/^Signed out: run codex login/)).toBeDefined();
  expect(api.setActiveCodexAccount).not.toHaveBeenCalled();
});

it('reads usage for every saved profile in the background and follows it (PM-173)', async () => {
  const limits = {
    providerId: 'codex',
    windows: [{ label: '5-hour', windowMinutes: 300, usedPercent: 42, resetsAt: null }],
    asOf: '2026-10-18T00:00:00Z',
    source: 'Codex account service',
  };
  vi.mocked(api.getCodexAccountsRefreshing).mockResolvedValue({
    ...baseState,
    usageRefreshing: true,
  });
  vi.mocked(api.getCodexAccounts).mockResolvedValue({
    ...baseState,
    usageRefreshing: false,
    accounts: baseState.accounts.map((a) => ({
      ...a,
      usageStatus: 'fresh',
      usageCheckedAt: new Date().toISOString(),
      limits,
    })),
  });
  render(<CodexAccountsPanel onError={vi.fn()} />);
  expect((await screen.findAllByText('Loading usage…')).length).toBeGreaterThan(0);
  expect(await screen.findByText('Usage checked just now', {}, { timeout: 4000 })).toBeDefined();
  expect(
    screen.getByRole('meter', { name: '5-hour limit used' }).getAttribute('aria-valuenow'),
  ).toBe('42');
});

it('revalidates usage while open and stops polling after closing the panel', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(api.getCodexAccountsRefreshing).mockResolvedValue(baseState);
    const { unmount } = render(<CodexAccountsPanel onError={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.getCodexAccountsRefreshing).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(api.getCodexAccountsRefreshing).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(api.getCodexAccountsRefreshing).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it('ignores a background response captured before switching accounts', async () => {
  let finish!: (state: CodexAccountsState) => void;
  vi.mocked(api.getCodexAccountsRefreshing).mockResolvedValue({
    ...baseState,
    usageRefreshing: true,
  });
  vi.mocked(api.getCodexAccounts).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.mocked(api.setActiveCodexAccount).mockResolvedValue({
    ...baseState,
    activeProfileId: baseState.accounts[0]!.id,
  });
  render(<CodexAccountsPanel onError={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Switch to account Work Pro' }));
  await screen.findByText('active: Work Pro');
  await act(async () => {
    finish(baseState);
  });
  expect(screen.getByText('active: Work Pro')).toBeDefined();
});

it('shows saved-account eligibility only while automatic switching is enabled', async () => {
  vi.mocked(api.getCodexAccounts).mockResolvedValue(baseState);
  vi.mocked(api.refreshCodexAccountsUsage).mockResolvedValue(baseState);
  const view = render(<CodexAccountsPanel onError={vi.fn()} />);
  const toggles = await screen.findAllByRole('checkbox', {
    name: /Include .* in automatic switching/,
  });
  expect((toggles[0] as HTMLInputElement).checked).toBe(true);
  vi.mocked(api.setCodexAccountAutoSwitchEligible).mockResolvedValue(baseState);
  fireEvent.click(toggles[0]!);
  await waitFor(() =>
    expect(api.setCodexAccountAutoSwitchEligible).toHaveBeenCalledWith(
      baseState.accounts[0]!.id,
      false,
    ),
  );
  view.unmount();
  vi.mocked(api.getCodexAccounts).mockResolvedValue({ ...baseState, autoSwitch: false });
  render(<CodexAccountsPanel onError={vi.fn()} />);
  await screen.findByText(baseState.accounts[0]!.name);
  expect(screen.queryByRole('checkbox', { name: /Include .* in automatic switching/ })).toBeNull();
});

it('ticks the supervisor check countdown and shows its guard and last failure', async () => {
  vi.useFakeTimers();
  try {
    vi.mocked(api.getCodexAccounts).mockResolvedValue({
      ...baseState,
      forecast: {
        kind: 'next',
        name: 'Work Pro',
        left: 80,
        fiveHour: 80,
        weekly: 90,
        atLimit: true,
      },
      rotation: {
        nextCheckAt: new Date(Date.now() + 10_000).toISOString(),
        waiting: 'Codex session 12 is still working.',
        error: 'Conversation could not be carried',
      },
    });
    const { unmount } = render(<CodexAccountsPanel onError={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Next check in 10s/).textContent).toContain(
      'Codex session 12 is still working.',
    );
    expect(screen.getByText(/Last switch failed/).textContent).toContain(
      'Conversation could not be carried',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText(/Next check in 9s/)).toBeDefined();
    unmount();
  } finally {
    vi.useRealTimers();
  }
});
