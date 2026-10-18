// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../../shared/types';
import { api } from '../api';
import { BatchAttentionActions, detectAttentionOverlay } from './BatchAttentionActions';

vi.mock('../api', () => ({
  api: {
    sessionScreen: vi.fn(),
    sendSessionInput: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const makeSession = (
  id: number,
  name: string,
  tailState: AgentSession['tailState'] = 'input',
): AgentSession =>
  ({
    id,
    name,
    status: 'running',
    terminal: 'pty',
    tailState,
  }) as AgentSession;

const CODEX_GOAL_POPUP_SCREEN = [
  '■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit h                                                                        at Oct 22nd, 2026 7:38 PM.',
  '                                                                                          Resume paused goal?',
  '                                                                                          Goal: never stop until the Storytelling queue reaches 0 (meaning all',
  '› continue                                                                                images are already generated)',
  '',
  '■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit h› 1. Resume goal   Mark it active and continue when idle                at Oct 22nd, 2026 7:38 PM.',
  '                                                                                          2. Leave paused  Keep it paused; use /goal resume later',
  '',
  '› Ask Codex to do anything                                                                enter select · esc back',
  '  GPT-6-Luna xhigh · S:\\Vibe Coding\\TrendRelay · Storytelling                                                                                                                                                     Goal hit usage limits (/goal resume)',
].join('\n');

const CODEX_GOAL_FOOTER_SCREEN = [
  '■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 22nd, 2026 7:38 PM.',
  '',
  '                                                                                                                                                                                                                  Goal hit usage lim ts (/goal resume',
].join('\n');

const CLAUDE_LIMIT_MENU_SCREEN = [
  "  ⎿  You've hit your weekly limit · resets Oct 18, 1pm (Asia/Bangkok)",
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ ◐ medium · /effort ▔',
  '   What do you want to do?                                                                         ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '',
  '   ❯ 1. Stop and wait for limit to reset',
  '     2. Wait here, then continue automatically at Oct 18, 1pm',
  '     3. Switch to usage credits',
  '     4. Upgrade your plan',
  '',
  '   Enter to confirm · Esc to cancel',
].join('\n');

describe('detectAttentionOverlay (PM-165)', () => {
  it('parses Codex Resume paused goal? TUI overlay even when drawn over background text', () => {
    const parsed = detectAttentionOverlay(CODEX_GOAL_POPUP_SCREEN);
    expect(parsed).toEqual({
      title: 'Resume paused goal?',
      options: [
        {
          key: 'resume-goal',
          label: '1. Resume goal',
          detail: 'Mark it active and continue when idle',
          command: { kind: 'key', data: '1' },
        },
        {
          key: 'pause-goal',
          label: '2. Leave paused',
          detail: 'Keep it paused; use /goal resume later',
          command: { kind: 'key', data: '2' },
        },
      ],
    });
  });

  it('parses paused goal footer when popup is closed', () => {
    const parsed = detectAttentionOverlay(CODEX_GOAL_FOOTER_SCREEN);
    expect(parsed).toEqual({
      title: 'Goal paused (/goal resume)',
      options: [
        {
          key: 'resume-goal',
          label: '1. Resume goal',
          detail: 'Send /goal resume to mark it active and continue when idle',
          command: { kind: 'line', text: '/goal resume' },
        },
        {
          key: 'pause-goal',
          label: '2. Leave paused',
          detail: 'Keep it paused; use /goal resume later',
          command: { kind: 'line', text: '/goal pause' },
        },
      ],
    });
  });

  it('parses Claude Code usage-limit choice overlay', () => {
    const parsed = detectAttentionOverlay(CLAUDE_LIMIT_MENU_SCREEN);
    expect(parsed?.title).toBe('What do you want to do?');
    expect(parsed?.options.map((o) => o.label)).toEqual([
      '1. Stop and wait for limit to reset',
      '2. Wait here, then continue automatically at Oct 18, 1pm',
      '3. Switch to usage credits',
      '4. Upgrade your plan',
    ]);
  });
});

describe('BatchAttentionActions (PM-165)', () => {
  it('retries only failed recipients and keeps queued delivery visible', async () => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
    const first = makeSession(1, 'Queued');
    const second = makeSession(2, 'Failed');
    vi.mocked(api.sessionScreen).mockResolvedValue({ text: CODEX_GOAL_POPUP_SCREEN });
    vi.mocked(api.sendSessionInput).mockImplementation(async (id) => {
      if (id === 2) throw new Error('Connection lost');
      return { queued: true, session: first };
    });
    render(<BatchAttentionActions sessions={[first, second]} isAttentionFilter />);
    fireEvent.click(screen.getByRole('button', { name: 'Batch CLI choices (2)' }));
    await screen.findByText('1. Resume goal');
    fireEvent.click(screen.getAllByText('Apply (2)')[0]!);
    await waitFor(() => expect(screen.getByText(/Failed: Connection lost/)).toBeDefined());
    expect(screen.getByText(/Queued "1. Resume goal"/)).toBeDefined();
    expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled();
    vi.mocked(api.sendSessionInput).mockResolvedValue({ queued: false, session: second });
    fireEvent.click(screen.getAllByText('Apply (1)')[0]!);
    await waitFor(() => expect(api.sendSessionInput).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.sendSessionInput).mock.calls.map(([id]) => id)).toEqual([1, 2, 2]);
  });

  it('detects and batch-applies Resume goal across popup and footer sessions', async () => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();

    const s1 = makeSession(45, 'Storytelling', 'input');
    const s2 = makeSession(42, 'Boom + Audition', 'input');

    vi.mocked(api.sessionScreen).mockImplementation(async (id) => ({
      text: id === 45 ? CODEX_GOAL_POPUP_SCREEN : CODEX_GOAL_FOOTER_SCREEN,
    }));
    vi.mocked(api.sendSessionInput).mockResolvedValue({ queued: false, session: s1 });

    render(<BatchAttentionActions sessions={[s1, s2]} isAttentionFilter />);

    fireEvent.click(screen.getByRole('button', { name: 'Batch CLI choices (2)' }));

    expect(await screen.findByText('1. Resume goal')).toBeDefined();
    expect(screen.getByText('2. Leave paused')).toBeDefined();

    const applyButtons = screen.getAllByText('Apply (2)');
    fireEvent.click(applyButtons[0]!);

    await waitFor(() =>
      expect(screen.getByRole('status', { hidden: true }).textContent).toContain(
        'Applied "1. Resume goal" to 2 of 2 sessions.',
      ),
    );
    expect(api.sendSessionInput).toHaveBeenCalledWith(45, '1');
    expect(api.sendSessionInput).toHaveBeenCalledWith(42, '\x1b[200~/goal resume\x1b[201~');
    expect(api.sendSessionInput).toHaveBeenCalledWith(42, '\r');
  });
});
