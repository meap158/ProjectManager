// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, SessionTranscript } from '../../../shared/types';
import { api } from '../api';
import { SessionChat, chatSupported } from './SessionChat';

vi.mock('../api', () => ({
  api: {
    sessionTranscript: vi.fn(),
    sessionScreen: vi.fn(async () => ({ text: 'Allow edit?\n❯ 1. Yes\n  2. No' })),
    sendSessionInput: vi.fn(async () => ({ queued: false })),
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const session = (over: Partial<AgentSession> = {}) =>
  ({
    id: 7,
    providerId: 'claude',
    terminal: 'pty',
    status: 'running',
    tailState: 'idle',
    ...over,
  }) as AgentSession;
const transcript = (over: Partial<SessionTranscript>): SessionTranscript => ({
  supported: true,
  items: [],
  next: 100,
  reset: false,
  ...over,
});

describe('SessionChat (mobile chat view)', () => {
  it('shows messages and tool calls with their output, and sends like typing', async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(
      transcript({
        items: [
          { id: 'u', kind: 'user', text: 'fix the build', at: null },
          { id: 'a', kind: 'assistant', text: 'Running **tests** with `npm test`.', at: null },
          {
            id: 't',
            kind: 'tool',
            toolId: 'x',
            name: 'Bash',
            summary: 'npm test',
            input: '{}',
            at: null,
          },
          { id: 'r', kind: 'result', toolId: 'x', text: '12 passed', at: null },
        ],
      }),
    );
    render(<SessionChat session={session()} onError={() => {}} />);
    expect(await screen.findByText('fix the build')).toBeDefined();
    expect(screen.getByText('tests').tagName).toBe('STRONG');
    expect(screen.getByText('npm test', { selector: 'code' })).toBeDefined();
    // The call shows its command; its output is inside, one tap away.
    expect(screen.getByText('npm test', { selector: '.chat-tool-summary' })).toBeDefined();
    expect(screen.getByText('12 passed')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Message to the session'), {
      target: { value: 'now commit\nand push' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendSessionInput).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.sendSessionInput).mock.calls.map((c) => c[1])).toEqual([
      '\x1b[200~now commit\nand push\x1b[201~',
      '\r',
    ]);
    await waitFor(() =>
      expect((screen.getByLabelText('Message to the session') as HTMLTextAreaElement).value).toBe(
        '',
      ),
    );
  });

  it('shows what the CLI asks, with keys to answer it', async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(transcript({}));
    render(<SessionChat session={session({ tailState: 'input' })} onError={() => {}} />);
    expect(await screen.findByText(/Allow edit\?/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    await waitFor(() => expect(api.sendSessionInput).toHaveBeenCalledWith(7, '1'));
  });

  it('is offered for terminal sessions of CLIs that keep a transcript', () => {
    expect(chatSupported(session())).toBe(true);
    expect(chatSupported(session({ providerId: 'codex' }))).toBe(true);
    expect(chatSupported(session({ providerId: 'grok' }))).toBe(false);
    expect(chatSupported(session({ terminal: 'pipe' }))).toBe(false);
  });
});

describe('SessionChat formatting', () => {
  it('renders Markdown tables as tables and folds a run of tool calls into one row', async () => {
    const tool = (id: string, summary: string, done = true) => [
      { id, kind: 'tool' as const, toolId: id, name: 'Bash', summary, input: '{}', at: null },
      ...(done
        ? [{ id: `${id}r`, kind: 'result' as const, toolId: id, text: 'ok', at: null }]
        : []),
    ];
    vi.mocked(api.sessionTranscript).mockResolvedValue(
      transcript({
        items: [
          {
            id: 'a',
            kind: 'assistant',
            text: '## Options\n| # | Idea |\n|---|---|\n| 1 | Consent bar |\n| 2 | Stamp strip |',
            at: null,
          },
          ...tool('t1', 'git status'),
          ...tool('t2', 'npm test'),
          ...tool('t3', 'npm run build', false),
        ],
      }),
    );
    render(<SessionChat session={session()} onError={() => {}} />);
    expect(await screen.findByRole('table')).toBeDefined();
    expect(screen.getByRole('columnheader', { name: 'Idea' })).toBeDefined();
    expect(screen.getByRole('cell', { name: 'Stamp strip' })).toBeDefined();
    expect(screen.getByText('Options').closest('.chat-heading')).not.toBeNull();
    // Three calls in a row: one row with the count and the latest step, still running.
    const steps = document.querySelector('.chat-steps')!;
    expect(steps.className).toContain('is-running');
    expect(steps.querySelector('summary')!.textContent).toMatch(/3 steps.*npm run build/);
    expect(steps.querySelectorAll('.chat-tool')).toHaveLength(3);
  });
});
