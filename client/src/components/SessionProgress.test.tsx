// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../../shared/types';
import { api } from '../api';
import { SessionProgress, SessionRestartStatus } from './SessionProgress';

vi.mock('../api', () => ({
  api: { setAutoContinue: vi.fn(), continueSessionNow: vi.fn() },
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 1,
    projectId: 1,
    name: 'Claude Code',
    command: ['claude'],
    cwd: 'C:/test',
    status: 'running',
    providerId: 'claude',
    terminal: 'pty',
    cardId: null,
    cardKey: null,
    pid: 1234,
    exitCode: null,
    desiredState: 'running',
    supervise: true,
    resumeSupported: true,
    restarts: 0,
    lastRestartAt: null,
    queuedInputBytes: 0,
    startedAt: '2026-10-11T00:00:00Z',
    createdAt: '2026-10-11T00:00:00Z',
    endedAt: null,
    logBytes: 0,
    lastOutputAt: null,
    tailState: null,
    ...overrides,
  } as AgentSession;
}

describe('SessionProgress', () => {
  it('returns null when non-codex session has no auto-continue or resume info', () => {
    const session = makeSession({ providerId: 'claude', terminal: 'pty' });
    const { container } = render(<SessionProgress session={session} />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when codex session is not a pty terminal and has no continuation', () => {
    const session = makeSession({ providerId: 'codex', terminal: 'pipe' });
    const { container } = render(<SessionProgress session={session} />);
    expect(container.firstChild).toBeNull();
  });

  it('offers auto-continue as an explicit checkbox on codex terminals (PM-58)', async () => {
    const session = makeSession({ providerId: 'codex', terminal: 'pty' });
    vi.mocked(api.setAutoContinue).mockResolvedValue(session);
    render(<SessionProgress session={session} />);
    const box = screen.getByRole('checkbox', {
      name: 'Auto-continue Claude Code when limits reset',
    }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(api.setAutoContinue).toHaveBeenCalledWith(1, true));
  });

  it('renders resume time when autoContinue.resumesAt is set', () => {
    const session = makeSession({
      providerId: 'codex',
      terminal: 'pty',
      autoContinue: { enabled: true, resumesAt: '2099-10-11T12:30:00Z', message: 'Paused' },
    });
    render(<SessionProgress session={session} />);
    expect(screen.getByText(/^Resumes /)).toBeDefined();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });

  it('shows the usage limit like Claude desktop: reset time, Try again, View details', async () => {
    const session = makeSession({
      providerId: 'codex',
      terminal: 'pty',
      usageLimit: { resetsAt: '2099-10-11T12:30:00Z' },
    });
    vi.mocked(api.continueSessionNow).mockRejectedValue(
      new Error('The terminal has text in its prompt: continue there'),
    );
    render(<SessionProgress session={session} />);
    expect(screen.getByRole('status').textContent).toMatch(/^Usage limit · resets /);
    expect(screen.getByText('Auto-continue when limits reset')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    expect(screen.getByText(/plan limit resets/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect((await screen.findByRole('alert')).textContent).toContain('text in its prompt');
    expect(api.continueSessionNow).toHaveBeenCalledWith(1);
  });

  it('says under a minute when the reset is seconds away (PM-58)', () => {
    const session = makeSession({
      providerId: 'codex',
      terminal: 'pty',
      usageLimit: { resetsAt: new Date(Date.now() + 30_000).toISOString() },
    });
    render(<SessionProgress session={session} />);
    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    expect(screen.getByText(/in under a minute/)).toBeDefined();
  });

  it('marks the reset due when its time has passed but the notice lingers (PM-58)', () => {
    const session = makeSession({
      providerId: 'codex',
      terminal: 'pty',
      usageLimit: { resetsAt: new Date(Date.now() - 5_000).toISOString() },
    });
    render(<SessionProgress session={session} />);
    expect(screen.getByRole('status').textContent).toMatch(/· due$/);
    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    expect(screen.getByText(/clears on the next check/)).toBeDefined();
  });

  it('offers quick Codex account switching when hitting usage limits (PM-164)', async () => {
    const session = makeSession({
      providerId: 'codex',
      terminal: 'pty',
      codexAccountId: 'default',
      codexAccountName: 'Default Codex account',
      usageLimit: { resetsAt: '2099-10-11T12:30:00Z' },
    });
    (api as Record<string, unknown>).getCodexAccounts = vi.fn().mockResolvedValue({
      activeProfileId: null,
      autoSwitch: true,
      defaultAccount: { available: true },
      accounts: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          name: 'Backup Pro',
          createdAt: '2026-10-17T00:00:00Z',
        },
      ],
    });
    const switchMock = vi.fn().mockResolvedValue(session);
    (api as Record<string, unknown>).switchSessionCodexAccount = switchMock;

    render(<SessionProgress session={session} />);
    const select = await screen.findByLabelText('Switch Codex account for every session');
    fireEvent.click(select);
    fireEvent.click(screen.getByRole('button', { name: 'Backup Pro' }));
    await waitFor(() =>
      expect(switchMock).toHaveBeenCalledWith(1, '11111111-1111-1111-1111-111111111111', true),
    );
  });
});

describe('SessionRestartStatus', () => {
  it('returns null when no restart is in progress', () => {
    const session = makeSession();
    const { container } = render(<SessionRestartStatus session={session} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders status when restartProgress is active', () => {
    const session = makeSession({ restartProgress: 'starting' });
    render(<SessionRestartStatus session={session} />);
    expect(screen.getByRole('status').textContent).toContain('Starting…');
  });
});
