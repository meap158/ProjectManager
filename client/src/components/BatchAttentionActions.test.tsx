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
    setAutoContinue: vi.fn(),
    continueSessionNow: vi.fn(),
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

// The shapes seen on real Needs attention screens (made-up text): a long Claude Code menu that
// scrolls (↓ on the last visible option, option 5 out of view), each option's description on
// the line below, and the question in the middle of a paragraph line.
const CLAUDE_SCROLLED_MENU_SCREEN = [
  '│ The optimizer cuts campaigns below a floor. What floor should it hold? (Last month: 3.5.)',
  '',
  '❯ 1. 3 (aggressive)',
  '     Most orders; thin margin per order.',
  '  2. 4 (balanced, recommended)',
  '     Matches what working campaigns reach now.',
  '  3. 5 (careful)',
  '     Fewer campaigns qualify to grow.',
  '↓ 4. Keep 10',
  "     Today's setting.",
  '────────────────────────────────────────',
  '  6. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

const CODEX_LIMIT_SCREEN = [
  '• Ran npm test',
  '',
  '■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 5:53 PM.',
  '',
  '› Ask Codex to do anything',
  '',
  '  ? for shortcuts',
].join('\n');

describe('detectAttentionOverlay on real screen shapes (PM-165)', () => {
  it('reads a scrolling menu whole: arrows, gaps, descriptions and the actual question', () => {
    const parsed = detectAttentionOverlay(CLAUDE_SCROLLED_MENU_SCREEN);
    expect(parsed?.title).toBe('What floor should it hold?');
    expect(parsed?.options.map((o) => o.label)).toEqual([
      '1. 3 (aggressive)',
      '2. 4 (balanced, recommended)',
      '3. 5 (careful)',
      '4. Keep 10',
      '6. Chat about this',
    ]);
    expect(parsed?.options[0]?.detail).toBe('Most orders; thin margin per order.');
    expect(parsed?.options[4]?.command).toEqual({ kind: 'key', data: '6' });
  });

  it('starts from the first visible option when the menu has scrolled past option 1', () => {
    const parsed = detectAttentionOverlay(
      ['Pick one?', '↑ 3. Third', '  4. Fourth', '❯ 5. Fifth', '', 'Enter to select'].join('\n'),
    );
    expect(parsed?.options.map((o) => o.label)).toEqual(['3. Third', '4. Fourth', '5. Fifth']);
  });

  it('shortens a question to its last sentence, joining one that wraps', () => {
    const parsed = detectAttentionOverlay(
      [
        'Running it would change live budgets and campaigns. What would you',
        'like me to do?',
        '',
        '❯ 1. Dry run',
        '  2. Run for real',
      ].join('\n'),
    );
    expect(parsed?.title).toBe('What would you like me to do?');
  });

  it('offers auto-continue and try again for a Codex terminal at its usage limit', () => {
    const codex = { providerId: 'codex', terminal: 'pty' as const, usageLimit: null };
    const parsed = detectAttentionOverlay(CODEX_LIMIT_SCREEN, codex);
    expect(parsed?.title).toBe('Usage limit reached');
    expect(parsed?.options.map((o) => o.command)).toEqual([
      { kind: 'auto-continue' },
      { kind: 'continue-now' },
    ]);
    // Other CLIs can't take these, and a paused goal keeps its own choices.
    expect(
      detectAttentionOverlay(CODEX_LIMIT_SCREEN, { ...codex, providerId: 'claude' }),
    ).toBeNull();
    expect(detectAttentionOverlay(CODEX_GOAL_FOOTER_SCREEN, codex)?.options[0]?.key).toBe(
      'resume-goal',
    );
  });
});

describe('BatchAttentionActions (PM-165)', () => {
  it('batch-applies usage-limit choices through the session actions, not keystrokes', async () => {
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
    const limited = {
      ...makeSession(76, 'Limited', null),
      providerId: 'codex',
      usageLimit: { resetsAt: null },
    } as AgentSession;
    vi.mocked(api.sessionScreen).mockResolvedValue({ text: CODEX_LIMIT_SCREEN });
    vi.mocked(api.setAutoContinue).mockResolvedValue(limited);
    // Eligible outside the attention filter too: at its limit, it shows rather than asks.
    render(<BatchAttentionActions sessions={[limited]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Batch CLI choices (1)' }));
    await screen.findByText('Auto-continue when the limit resets');
    fireEvent.click(screen.getAllByText('Apply (1)')[0]!);
    await waitFor(() => expect(api.setAutoContinue).toHaveBeenCalledWith(76, true));
    expect(api.sendSessionInput).not.toHaveBeenCalled();
  });

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
