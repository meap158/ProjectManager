// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, SessionTranscript } from '../../../shared/types';
import { api } from '../api';
import {
  CLEAR_INPUT,
  SessionChat,
  chatSupported,
  handOffDraft,
  isImageFile,
  screenInfo,
  statusParts,
  modeKind,
  editDiff,
  proposedPlan,
  statusLine,
} from './SessionChat';

vi.mock('../api', () => ({
  api: {
    sessionTranscript: vi.fn(),
    sessionSubagent: vi.fn(),
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
      CLEAR_INPUT,
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
    expect(chatSupported(session({ providerId: 'grok' }))).toBe(true);
    expect(chatSupported(session({ providerId: 'opencode' }))).toBe(true);
    expect(chatSupported(session({ providerId: 'antigravity' }))).toBe(true);
    expect(chatSupported(session({ providerId: 'shell' }))).toBe(false);
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
        CLEAR_INPUT,
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
        CLEAR_INPUT,
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
    fireEvent.click(screen.getByRole('button', { name: 'continue' }));
    await waitFor(() =>
      expect(vi.mocked(api.sendSessionInput).mock.calls.map((c) => c[1])).toEqual([
        CLEAR_INPUT,
        '\x1b[200~continue\x1b[201~',
        '\r',
      ]),
    );
    expect(box().value).toBe('my draft');
    expect(document.querySelector('.chat-msg.is-pending')!.textContent).toContain('continue');
    view.unmount();
    render(<SessionChat session={session({ tailState: 'input' })} onError={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Enter' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'continue' })).toBeNull();
  });
});

describe('screenInfo (PM-122)', () => {
  it('reads the status line, background agents and mode the terminal shows', () => {
    // The owner's screenshot: a Claude Code session waiting on two background agents.
    const screen = [
      "  I'm holding the next items (touch",
      '  targets under 44 px, keyboard play)',
      '* Waiting for 2 background agents to',
      '  finish',
      '────────────────────────────────────',
      '>',
      '────────────────────────────────────',
      '  ▸▸ auto mode on (shift+tab to cycle)',
      '  ● main',
      '  ( ) general-purpose 6m 16s · ↓ 113.8k',
      '  ( ) general-purpose t6m 16s · ↓ 96.9k',
    ].join('\n');
    expect(screenInfo(screen)).toEqual({
      status: 'Waiting for 2 background agents to finish',
      mode: 'auto mode on',
      background: ['general-purpose · 6m 16s · ↓ 113.8k', 'general-purpose · 6m 16s · ↓ 96.9k'],
      goal: null,
    });
  });

  it('takes Codex output bullets for output, not a status line', () => {
    expect(screenInfo('• Ran npm test\n• Edited 2 files\n› Ask Codex to do anything')).toEqual({
      status: null,
      mode: null,
      background: [],
      goal: null,
    });
    expect(screenInfo('• Working (2m 03s • esc to interrupt)').status).toBe('Working (2m 03s)');
  });

  it("reads Claude Code's goal line and splits the status line as the CLI colours it (PM-134)", () => {
    const info = screenInfo(
      [
        '✻ Finagling… (7m 49s · ↓ 7.8k tokens · esc to interrupt)',
        '────────────────────────────────────',
        '>',
        '──────────────── ◎ /goal active (26m) ─',
        '  ⏵⏵ accept edits on (shift+tab to cycle)',
      ].join('\n'),
    );
    expect(info.goal).toBe('/goal active (26m)');
    expect(info.mode).toBe('accept edits on');
    expect(statusParts(info.status!)).toEqual({
      activity: 'Finagling…',
      details: '(7m 49s · ↓ 7.8k tokens)',
    });
    expect(statusParts('Waiting for 2 background agents')).toEqual({
      activity: 'Waiting for 2 background agents',
      details: '',
    });
    expect(
      ['auto mode on', 'plan mode on', 'accept edits on', 'bypass permissions on'].map(modeKind),
    ).toEqual(['auto', 'plan', 'accept', 'bypass']);
  });
});

describe('quick key order (PM-121)', () => {
  it('puts Continue first, before Esc; Enter takes its place while the CLI asks', async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(transcript({}));
    const view = render(<SessionChat session={session()} onError={() => {}} />);
    await screen.findByLabelText('Message to the session');
    const keys = () =>
      [...document.querySelectorAll('.chat-keys button')].map(
        (b) => b.getAttribute('aria-label') ?? b.textContent,
      );
    expect(keys().slice(0, 2)).toEqual(['continue', 'Escape']);
    expect(keys()).not.toContain('Enter');
    view.unmount();
    render(<SessionChat session={session({ tailState: 'input' })} onError={() => {}} />);
    await screen.findByText(/Allow edit\?/);
    expect(keys().slice(0, 2)).toEqual(['Enter', 'Escape']);
  });
});

describe('reply rendering (PM-120)', () => {
  it('renders lists, links, quotes and dividers; only http(s) links are links', async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(
      transcript({
        items: [
          {
            id: 'a',
            kind: 'assistant',
            text: [
              'Done:',
              '- Fixed the **table**',
              '- See [the PR](https://github.com/x/y/pull/1).',
              '1. first',
              '2. second',
              '> quoted note',
              '---',
              'Docs at https://example.com/guide, and javascript:alert(1) stays text.',
            ].join('\n'),
            at: null,
          },
        ],
      }),
    );
    render(<SessionChat session={session()} onError={() => {}} />);
    const pr = await screen.findByRole('link', { name: 'the PR' });
    expect(pr.getAttribute('href')).toBe('https://github.com/x/y/pull/1');
    expect(pr.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('link', { name: 'https://example.com/guide' })).toBeDefined();
    expect(screen.getAllByRole('link')).toHaveLength(2); // javascript: is never a link.
    const lists = screen.getAllByRole('list');
    expect(lists.map((l) => l.tagName)).toEqual(['UL', 'OL']);
    expect(lists[0]!.querySelectorAll('li')).toHaveLength(2);
    expect(document.querySelector('blockquote')!.textContent).toBe('quoted note');
    expect(document.querySelector('hr.chat-rule')).not.toBeNull();
  });
});

describe('tools that speak to you (PM-123)', () => {
  it('shows a question with its options and a plan as a checklist, never folded', async () => {
    const tool = (id: string, name: string, input: unknown) => ({
      id,
      kind: 'tool' as const,
      toolId: id,
      name,
      summary: name,
      input: JSON.stringify(input),
      at: null,
    });
    vi.mocked(api.sessionTranscript).mockResolvedValue(
      transcript({
        items: [
          tool('b1', 'Bash', { command: 'git status' }),
          tool('q', 'AskUserQuestion', {
            questions: [
              {
                question: 'Which layout should the phone use?',
                options: [{ label: 'Stacked', description: 'one column' }, { label: 'Tabs' }],
              },
            ],
          }),
          tool('b2', 'Bash', { command: 'npm test' }),
          tool('p', 'TodoWrite', {
            todos: [
              { content: 'Fix tables', activeForm: 'Fixing tables', status: 'completed' },
              { content: 'Add lists', activeForm: 'Adding lists', status: 'in_progress' },
              { content: 'Ship', activeForm: 'Shipping', status: 'pending' },
            ],
          }),
        ],
      }),
    );
    render(<SessionChat session={session()} onError={() => {}} />);
    expect(await screen.findByText('Which layout should the phone use?')).toBeDefined();
    expect(screen.getByText('Stacked')).toBeDefined();
    expect(screen.getByText('Tabs')).toBeDefined();
    expect(screen.getByText('Plan · 1/3 done')).toBeDefined();
    expect(screen.getByText('Adding lists')).toBeDefined(); // In progress shows what it does.
    // The question and the plan sit between the Bash calls, not folded into a steps group.
    expect(document.querySelectorAll('.chat-steps')).toHaveLength(0);
    expect(document.querySelectorAll('.chat-card')).toHaveLength(2);
  });
});

describe('only the typed message is sent (PM-125)', () => {
  /** A readline-style input: Ctrl+E end of line, Ctrl+U delete to line start, Backspace. */
  const edit = (text: string, keys: string) => {
    let value = text;
    let cursor = value.length;
    for (const key of keys) {
      const start = value.lastIndexOf('\n', cursor - 1) + 1;
      if (key === '\x05') {
        const end = value.indexOf('\n', cursor);
        cursor = end < 0 ? value.length : end;
      } else if (key === '\x15') {
        value = value.slice(0, start) + value.slice(cursor);
        cursor = start;
      } else if (key === '\x7f' && cursor > 0) {
        value = value.slice(0, cursor - 1) + value.slice(cursor);
        cursor--;
      }
    }
    return value;
  };
  it("empties the CLI's whole input, not just its last line", () => {
    // E.g. two queued messages Claude put back into its input after an Esc.
    const leftover = 'first queued message\nsecond line of it\nanother queued message';
    expect(edit(leftover, '\x05\x15')).toBe('first queued message\nsecond line of it\n'); // Before.
    expect(edit(leftover, CLEAR_INPUT)).toBe('');
    expect(edit('', CLEAR_INPUT)).toBe(''); // Harmless on an empty input.
  });
});

describe('message box size (PM-128)', () => {
  it('fits a draft carried over from the terminal view, not only typed text', async () => {
    sessionStorage.setItem('pm.chatDraft.7', 'line one\nline two\nline three');
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return (this as HTMLTextAreaElement).value ? 72 : 20;
      },
    });
    try {
      vi.mocked(api.sessionTranscript).mockResolvedValue(transcript({}));
      render(<SessionChat session={session()} onError={() => {}} />);
      const input = (await screen.findByLabelText('Message to the session')) as HTMLTextAreaElement;
      expect(input.value).toBe('line one\nline two\nline three');
      expect(input.style.height).toBe('72px'); // Sized to the restored text at once.
      fireEvent.change(input, { target: { value: '' } });
      expect(input.style.height).toBe(''); // Empty: back to one line.
    } finally {
      delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
      if (height) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', height);
      sessionStorage.clear();
    }
  });
});

describe('images on phones (PM-130)', () => {
  it('takes an image pasted only through clipboard items (iPhone Safari)', async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(transcript({}));
    URL.createObjectURL = vi.fn(() => 'blob:x');
    render(<SessionChat session={session()} onError={() => {}} />);
    const input = await screen.findByLabelText('Message to the session');
    const image = new File([new Uint8Array([137, 80])], 'IMG_0001.png', { type: 'image/png' });
    fireEvent.paste(input, {
      clipboardData: {
        files: [],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
        getData: () => '',
      },
    });
    expect(await screen.findByRole('img', { name: 'IMG_0001.png' })).toBeDefined();
  });

  it('accepts a photo with no type by its name, and says why when one fails', async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(transcript({}));
    vi.mocked(api.uploadSessionImage).mockRejectedValueOnce(new Error('Image over 8 MB'));
    render(<SessionChat session={session()} onError={() => {}} />);
    const input = await screen.findByLabelText('Message to the session');
    const photo = new File([new Uint8Array([255, 216])], 'IMG_0002.jpg', { type: '' });
    expect(isImageFile(photo)).toBe(true);
    expect(isImageFile(new File(['x'], 'notes.txt', { type: '' }))).toBe(false);
    fireEvent.paste(input, { clipboardData: { files: [photo], getData: () => '' } });
    expect((await screen.findByRole('alert')).textContent).toContain(
      "Couldn't add IMG_0002.jpg: Image over 8 MB",
    );
  });
});

describe('loading (PM-127)', () => {
  it('shows message-shaped placeholders until the transcript arrives', async () => {
    let resolve: (t: ReturnType<typeof transcript>) => void = () => {};
    vi.mocked(api.sessionTranscript).mockReturnValue(new Promise((r) => (resolve = r)));
    render(<SessionChat session={session()} onError={() => {}} />);
    const loading = screen.getByRole('status', { name: 'Loading messages' });
    expect(loading.querySelectorAll('.chat-loading-bubble')).toHaveLength(4);
    resolve(transcript({}));
    expect(await screen.findByText('No messages yet. Send one below.')).toBeDefined();
    expect(screen.queryByRole('status', { name: 'Loading messages' })).toBeNull();
  });
});

describe('edits and plans (PM-123)', () => {
  it("shows Claude's edits and Codex's patches as diffs", () => {
    const edit = JSON.stringify({ file_path: 'a.ts', old_string: 'one', new_string: 'two\nthree' });
    expect(editDiff('Edit', edit)).toEqual([
      { kind: 'file', text: 'a.ts' },
      { kind: 'del', text: 'one' },
      { kind: 'add', text: 'two' },
      { kind: 'add', text: 'three' },
    ]);
    const patch = '*** Begin Patch\n*** Update File: b.ts\n@@\n keep\n-old\n+new\n*** End Patch';
    expect(editDiff('apply_patch', patch)).toEqual([
      { kind: 'file', text: 'Update File: b.ts' },
      { kind: 'file', text: '@@' },
      { kind: 'same', text: 'keep' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' },
    ]);
    expect(editDiff('Bash', '{"command":"ls"}')).toBeNull();
    expect(editDiff('Edit', '{"file_path": "cut short')).toBeNull();
  });

  it('shows the plan Claude asks to approve as a card with its state', async () => {
    expect(proposedPlan(JSON.stringify({ plan: '## Steps\n1. Do it' }))).toBe('## Steps\n1. Do it');
    expect(proposedPlan('{}')).toBeNull();
    vi.mocked(api.sessionTranscript).mockResolvedValue(
      transcript({
        items: [
          {
            id: 't1',
            kind: 'tool',
            toolId: 't1',
            name: 'ExitPlanMode',
            input: '{"plan":"Rename the field"}',
            summary: '',
            at: null,
          },
        ],
      }),
    );
    render(<SessionChat session={session()} onError={() => {}} />);
    expect((await screen.findByText(/waiting for your approval/)).textContent).toContain('Plan');
    expect(screen.getByText('Rename the field')).toBeDefined();
  });
});

describe('subagent steps (PM-123)', () => {
  it("loads an Agent step's own steps when asked", async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(
      transcript({
        items: [
          {
            id: 't1',
            kind: 'tool',
            toolId: 'toolu_1',
            name: 'Agent',
            input: '{}',
            summary: 'Find it',
            at: null,
          },
        ],
      }),
    );
    vi.mocked(api.sessionSubagent).mockResolvedValue({
      items: [{ id: 'm1', kind: 'assistant', text: 'Found it in sort.ts', at: null }],
    });
    render(<SessionChat session={session()} onError={() => {}} />);
    fireEvent.click(await screen.findByText('Show its steps'));
    expect(await screen.findByText('Found it in sort.ts')).toBeDefined();
    expect(api.sessionSubagent).toHaveBeenCalledWith(7, 'toolu_1');
  });
});

describe('status shimmer (PM-134)', () => {
  it("shimmers on the CLI's live activity line, not on a finished one", async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue(transcript({}));
    vi.mocked(api.sessionScreen).mockResolvedValueOnce({
      text: '✻ Recombobulating… (5s · ↓ 1.2k tokens)\n────\n>\n────',
    });
    const { container, unmount } = render(<SessionChat session={session()} onError={() => {}} />);
    await screen.findByText('Recombobulating…');
    expect(container.querySelector('.chat-working.is-working')).not.toBeNull();
    unmount();
    vi.mocked(api.sessionScreen).mockResolvedValueOnce({
      text: '✻ Churned for 2m 3s\n────\n>\n────',
    });
    const calls = vi.mocked(api.sessionScreen).mock.calls.length;
    const done = render(<SessionChat session={session()} onError={() => {}} />);
    await waitFor(() => expect(vi.mocked(api.sessionScreen).mock.calls.length).toBe(calls + 1));
    expect(done.container.querySelector('.chat-working.is-working')).toBeNull();
  });
});

describe('transcript unavailable', () => {
  it('says why a session has no transcript instead of an empty chat', async () => {
    vi.mocked(api.sessionTranscript).mockResolvedValue({
      ...transcript({}),
      supported: false,
      unavailable: 'This session started before ProjectManager pinned its conversation.',
    });
    render(<SessionChat session={session({ providerId: 'grok' })} onError={() => {}} />);
    expect(
      await screen.findByText(
        'This session started before ProjectManager pinned its conversation.',
      ),
    ).toBeDefined();
  });
});
