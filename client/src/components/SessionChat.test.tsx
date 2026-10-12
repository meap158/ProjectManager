// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, SessionTranscript } from '../../../shared/types';
import { api } from '../api';
import { SessionChat, chatSupported, handOffDraft, statusLine } from './SessionChat';

vi.mock('../api', () => ({
  api: {
    sessionTranscript: vi.fn(),
    sessionScreen: vi.fn(async () => ({ text: 'Allow edit?\n❯ 1. Yes\n  2. No' })),
    sendSessionInput: vi.fn(async () => ({ queued: false })),
    uploadSessionImage: vi.fn(async () => ({ path: 'S:/data/attachments/shot.png' })),
    sessionCommands: vi.fn(async () => [
      { name: 'compact', description: 'Summarise the conversation', source: 'builtin' },
      { name: 'clear', description: 'Clear the conversation', source: 'builtin' },
      { name: 'deploy', description: 'Ship it', source: 'project' },
    ]),
    sessionFiles: vi.fn(async (_id: number, q: string) =>
      q ? ['client/src/App.tsx', 'server/app.ts'] : [],
    ),
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
    fireEvent.keyDown(screen.getByLabelText('Message to the session'), { key: 'Enter' }); // Return sends, as in the CLI.
    // Only what was typed: the CLI's input line is cleared first (Ctrl+E, Ctrl+U).
    await waitFor(() => expect(api.sendSessionInput).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.sendSessionInput).mock.calls.map((c) => c[1])).toEqual([
      '\x05\x15',
      '\x1b[200~now commit\nand push\x1b[201~',
      '\r',
    ]);
    // Shown in the chat at once, until the transcript records it.
    expect(document.querySelector('.chat-msg.is-pending')!.textContent).toContain('now commit');
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

describe('SessionChat keys behave as in the terminal (PM-116)', () => {
  const history = transcript({
    items: [
      { id: 'u1', kind: 'user', text: 'first message', at: null },
      { id: 'a1', kind: 'assistant', text: 'ok', at: null },
      { id: 'u2', kind: 'user', text: 'second message', at: null },
    ],
  });
  const box = () => screen.getByLabelText('Message to the session') as HTMLTextAreaElement;

  it('↑ / ↓ recall earlier messages into the box; ⏎ sends the box', async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(history);
    render(<SessionChat session={session()} onError={() => {}} />);
    await screen.findByText('second message');
    fireEvent.change(box(), { target: { value: 'half typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Arrow up' }));
    expect(box().value).toBe('second message');
    fireEvent.click(screen.getByRole('button', { name: 'Arrow up' }));
    expect(box().value).toBe('first message');
    fireEvent.click(screen.getByRole('button', { name: 'Arrow down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Arrow down' }));
    expect(box().value).toBe('half typed'); // Back to what was being typed.
    expect(api.sendSessionInput).not.toHaveBeenCalled(); // Nothing went to the CLI.
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() =>
      expect(api.sendSessionInput).toHaveBeenCalledWith(7, '\x1b[200~half typed\x1b[201~'),
    );
  });

  it('while the CLI asks something, the keys go to it', async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(history);
    render(<SessionChat session={session({ tailState: 'input' })} onError={() => {}} />);
    await screen.findByText(/Allow edit\?/);
    fireEvent.click(screen.getByRole('button', { name: 'Arrow down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    await waitFor(() =>
      expect(vi.mocked(api.sendSessionInput).mock.calls.map((c) => c[1])).toEqual(['\x1b[B', '\r']),
    );
    expect(box().value).toBe('');
  });

  it('marks a message sent while the CLI works as queued', async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(history);
    render(<SessionChat session={session({ tailState: 'running' })} onError={() => {}} />);
    await screen.findByText('second message');
    fireEvent.change(box(), { target: { value: 'also do this' } });
    fireEvent.keyDown(screen.getByLabelText('Message to the session'), { key: 'Enter' }); // Return sends, as in the CLI.
    expect(await screen.findByText(/Queued, sends when the CLI is done/)).toBeDefined();
  });

  it('keeps the unsent message when switching away, and types it into the terminal', async () => {
    sessionStorage.clear();
    vi.mocked(api.sessionTranscript).mockResolvedValue(history);
    const view = render(<SessionChat session={session()} onError={() => {}} />);
    await screen.findByText('second message');
    fireEvent.change(box(), { target: { value: 'not sent yet' } });
    // Switching to the terminal view hands the draft over (the pane calls this on the switch).
    handOffDraft(7);
    view.unmount();
    await waitFor(() =>
      expect(vi.mocked(api.sendSessionInput).mock.calls.map((c) => c[1])).toEqual([
        '\x05\x15',
        '\x1b[200~not sent yet\x1b[201~', // In the CLI's input line, not submitted.
      ]),
    );
    render(<SessionChat session={session()} onError={() => {}} />);
    await screen.findByText('second message');
    expect(box().value).toBe('not sent yet');
    sessionStorage.clear();
  });
});

describe('statusLine', () => {
  it("reads the CLI's live status line instead of a bare Working…", () => {
    expect(
      statusLine('● Running tests\n✻ Finagling… (7m 49s · ↓ 7.8k tokens · thinking)\n> '),
    ).toBe('Finagling… (7m 49s · ↓ 7.8k tokens · thinking)');
    expect(statusLine('• Working (8m 05s • esc to interrupt)\n› Ask Codex')).toBe(
      'Working (8m 05s)',
    );
    expect(statusLine('nothing busy here')).toBeNull();
  });
});

describe('SessionChat images (PM-116)', () => {
  it('takes a pasted image and sends its path before the text, as the terminal does', async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(transcript({}));
    render(<SessionChat session={session()} onError={() => {}} />);
    const input = await screen.findByLabelText('Message to the session');
    const image = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
    URL.createObjectURL = vi.fn(() => 'blob:shot');
    URL.revokeObjectURL = vi.fn();
    fireEvent.paste(input, { clipboardData: { files: [image], getData: () => '' } });
    expect(await screen.findByRole('img', { name: 'shot.png' })).toBeDefined();
    expect(api.uploadSessionImage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ type: 'image/png' }),
    );
    fireEvent.change(input, { target: { value: 'what is wrong here?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(vi.mocked(api.sendSessionInput).mock.calls.map((c) => c[1])).toEqual([
        '\x05\x15',
        '\x1b[200~S:/data/attachments/shot.png\x1b[201~',
        '\x1b[200~what is wrong here?\x1b[201~',
        '\r',
      ]),
    );
    expect(screen.queryByRole('img', { name: 'shot.png' })).toBeNull();
  });

  it('Shift+Return adds a line instead of sending', async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(transcript({}));
    render(<SessionChat session={session()} onError={() => {}} />);
    const input = await screen.findByLabelText('Message to the session');
    fireEvent.change(input, { target: { value: 'line one' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(api.sendSessionInput).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull(); // No Send button.
  });
});

describe('SessionChat suggestions (PM-117)', () => {
  const box = () => screen.getByLabelText('Message to the session') as HTMLTextAreaElement;
  it('suggests slash commands as you type "/", picked with the keys like in the CLI', async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(transcript({}));
    render(<SessionChat session={session()} onError={() => {}} />);
    await waitFor(() => expect(api.sessionCommands).toHaveBeenCalled());
    fireEvent.change(box(), { target: { value: '/c' } });
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      '/compactSummarise the conversation',
      '/clearClear the conversation',
    ]);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(box(), { key: 'Enter' }); // Picks; doesn't send.
    expect(box().value).toBe('/clear ');
    expect(api.sendSessionInput).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    // Esc closes the list; typing on brings it back.
    fireEvent.change(box(), { target: { value: '/de' } });
    expect(await screen.findByRole('option', { name: /deploy/ })).toBeDefined();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('suggests project files after "@"', async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(transcript({}));
    render(<SessionChat session={session()} onError={() => {}} />);
    fireEvent.change(await screen.findByLabelText('Message to the session'), {
      target: { value: 'look at @app' },
    });
    const option = await screen.findByRole('option', { name: /App\.tsx/ });
    expect(api.sessionFiles).toHaveBeenCalledWith(7, 'app');
    fireEvent.pointerDown(option);
    expect(box().value).toBe('look at @client/src/App.tsx ');
  });

  it('shrinks the message box back to one line after sending', async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(transcript({}));
    render(<SessionChat session={session()} onError={() => {}} />);
    const input = await screen.findByLabelText('Message to the session');
    input.style.height = '120px';
    fireEvent.change(input, { target: { value: 'a\nb\nc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.style.height).toBe(''));
  });
});

describe('Continue key (PM-121)', () => {
  const box = () => screen.getByLabelText('Message to the session') as HTMLTextAreaElement;
  it('sends "continue" without touching what you are typing; ⏎ returns while the CLI asks', async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(transcript({}));
    const view = render(<SessionChat session={session()} onError={() => {}} />);
    await screen.findByLabelText('Message to the session');
    expect(screen.queryByRole('button', { name: 'Enter' })).toBeNull();
    fireEvent.change(box(), { target: { value: 'my draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(vi.mocked(api.sendSessionInput).mock.calls.map((c) => c[1])).toEqual([
        '\x05\x15',
        '\x1b[200~continue\x1b[201~',
        '\r',
      ]),
    );
    expect(box().value).toBe('my draft');
    expect(document.querySelector('.chat-msg.is-pending')!.textContent).toContain('continue');
    view.unmount();
    render(<SessionChat session={session({ tailState: 'input' })} onError={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Enter' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });
});
