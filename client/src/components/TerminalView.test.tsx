// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentOutput } from '../../../shared/types';
import { MAX_INITIAL_HISTORY_BYTES, TerminalView } from './TerminalView';

// xterm renders to a canvas jsdom lacks; a fake records what the component does with it.
const terms = vi.hoisted(
  () =>
    [] as {
      options: { fontSize?: number; disableStdin?: boolean };
      written: string;
      onDataCb: ((d: string) => void) | null;
      keyHandler: ((e: KeyboardEvent) => boolean) | null;
      element: HTMLElement | undefined;
      pasted: string;
      buffer: { active: { type: string } };
      scrolled: number[];
      cols: number;
      rows: number;
      geometryHandler: ((data: string) => boolean) | null;
      bottomScrolls: number;
      pendingWrites: (() => void)[];
    }[],
);
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    written = '';
    onDataCb: ((d: string) => void) | null = null;
    keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
    element: HTMLElement | undefined = undefined;
    pasted = '';
    buffer = { active: { type: 'normal' } };
    scrolled: number[] = [];
    geometryHandler: ((data: string) => boolean) | null = null;
    bottomScrolls = 0;
    pendingWrites: (() => void)[] = [];
    scrollToBottom() {
      this.bottomScrolls++;
    }
    refresh() {}
    parser = {
      registerOscHandler: (_id: number, handler: (data: string) => boolean) => {
        this.geometryHandler = handler;
        return { dispose() {} };
      },
    };
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    scrollLines(lines: number) {
      this.scrolled.push(lines);
    }
    paste(text: string) {
      this.pasted += text;
    }
    attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    constructor(options: Record<string, unknown>) {
      this.options = options;
      terms.push(this as never);
    }
    loadAddon() {}
    open(host: HTMLElement) {
      this.element = document.createElement('div');
      this.element.appendChild(document.createElement('textarea'));
      host.appendChild(this.element);
    }
    focus() {
      if (this.element?.parentElement?.style.visibility !== 'hidden') {
        this.element?.querySelector('textarea')?.focus();
      }
    }
    dispose() {}
    write(data: string, callback?: () => void) {
      this.written += data;
      if (callback) this.pendingWrites.push(callback);
    }
    onData(cb: (d: string) => void) {
      this.onDataCb = cb;
      return { dispose() {} };
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

class FakeEventSource {
  static last: FakeEventSource | null = null;
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, cb: (e: MessageEvent) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  emit(type: string, data: unknown) {
    for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) } as MessageEvent);
  }
  close() {}
}

beforeAll(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  terms.length = 0;
  FakeEventSource.last = null;
});

const noFetch = vi.fn(async (): Promise<AgentOutput> => {
  throw new Error('not used');
});

describe('TerminalView', () => {
  it('recovers a silent stream that never emits output or an error', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
    });
    try {
      const fetchOutput = vi.fn(async (): Promise<AgentOutput> => ({
        data: '',
        nextOffset: 0,
        logBytes: 0,
        running: false,
        exitCode: 0,
      }));
      render(
        <TerminalView fetchOutput={fetchOutput} streamUrl={() => '/stream'} historyBytes={100} />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16);
      });
      expect(FakeEventSource.last).not.toBeNull();
      expect(fetchOutput).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000);
      });
      expect(fetchOutput).toHaveBeenCalledWith(0);
      act(() => {
        terms.at(-1)!.pendingWrites.shift()!();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16);
      });
      expect(screen.getByRole('log').style.visibility).toBe('');
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('reveals drained history when the initial byte count was stale', async () => {
    render(<TerminalView fetchOutput={noFetch} streamUrl={() => '/stream'} historyBytes={100} />);
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    const host = screen.getByRole('log', { hidden: true });
    const term = terms.at(-1)!;
    FakeEventSource.last!.emit('output', { data: 'short history', nextOffset: 13 });
    FakeEventSource.last!.emit('state', { running: true, logBytes: 13, nextOffset: 13 });
    expect(host.style.visibility).toBe('hidden');
    term.pendingWrites.shift()!();
    expect(host.style.visibility).toBe('hidden');
    term.pendingWrites.shift()!();
    await waitFor(() => expect(host.style.visibility).toBe(''));
    expect(term.written).toBe('short history');
  });

  it('unhides an empty log instead of waiting forever for stale history', async () => {
    render(<TerminalView fetchOutput={noFetch} streamUrl={() => '/stream'} historyBytes={100} />);
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    FakeEventSource.last!.emit('state', { running: false, logBytes: 0, nextOffset: 0 });
    terms.at(-1)!.pendingWrites.shift()!();
    await waitFor(() => expect(screen.getByRole('log').style.visibility).toBe(''));
    expect(screen.getByText('Waiting for CLI output…')).toBeTruthy();
  });

  it('recovers streaming failures with a successful output fetch', async () => {
    const fetchOutput = vi.fn(async (): Promise<AgentOutput> => ({
      data: 'recovered',
      nextOffset: 9,
      logBytes: 9,
      running: false,
      exitCode: 0,
    }));
    render(
      <TerminalView fetchOutput={fetchOutput} streamUrl={() => '/stream'} historyBytes={100} />,
    );
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    FakeEventSource.last!.onerror!();
    expect(await screen.findByText('Reconnecting…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchOutput).toHaveBeenCalled());
    const term = terms.at(-1)!;
    term.pendingWrites.shift()!();
    // Poll again to receive the drain after the recovered bytes.
    fetchOutput.mockResolvedValue({
      data: '',
      nextOffset: 9,
      logBytes: 9,
      running: false,
      exitCode: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchOutput).toHaveBeenCalledTimes(2));
    term.pendingWrites.shift()!();
    await waitFor(() => expect(screen.getByRole('log').style.visibility).toBe(''));
    expect(term.written).toBe('recovered');
  });

  it('focuses the CLI after hidden history replay so typing can begin immediately', async () => {
    render(
      <TerminalView
        fetchOutput={noFetch}
        streamUrl={() => '/stream'}
        historyBytes={10}
        onInput={() => {}}
      />,
    );
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    const host = screen.getByRole('application', { hidden: true });
    expect(host.contains(document.activeElement)).toBe(false);
    FakeEventSource.last!.emit('output', { data: '0123456789', nextOffset: 10 });
    terms[0]!.pendingWrites.shift()!();
    await waitFor(() => expect(host.contains(document.activeElement)).toBe(true));
    expect(screen.queryByText('CLI focused')).toBeNull();
  });

  // A phone or a desktop window: the visual viewport shrinks from 800 to 450 px.
  const withViewport = async (
    coarse: boolean,
    body: (v: { height: number } & EventTarget) => Promise<void>,
  ) => {
    const viewport = Object.assign(new EventTarget(), {
      height: 800,
      width: 390,
      offsetTop: 0,
      offsetLeft: 0,
    });
    const saved = {
      visualViewport: Object.getOwnPropertyDescriptor(window, 'visualViewport'),
      requestAnimationFrame: window.requestAnimationFrame,
      matchMedia: window.matchMedia,
      scrollBy: window.scrollBy,
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    };
    window.matchMedia = ((query: string) => ({
      matches: coarse && query === '(pointer: coarse)',
    })) as unknown as typeof window.matchMedia;
    try {
      await body(viewport);
    } finally {
      // Put back only what this test changed (the file's shared stubs stay), even on failure.
      if (saved.visualViewport)
        Object.defineProperty(window, 'visualViewport', saved.visualViewport);
      else delete (window as { visualViewport?: unknown }).visualViewport;
      window.requestAnimationFrame = saved.requestAnimationFrame;
      window.matchMedia = saved.matchMedia;
      window.scrollBy = saved.scrollBy;
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  };
  const mountFocused = async () => {
    const scrollIntoView = vi.fn();
    window.scrollBy = scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    render(<TerminalView fetchOutput={noFetch} streamUrl={() => '/stream'} onInput={() => {}} />);
    await waitFor(() => expect(terms[0]?.element).toBeTruthy());
    const host = screen.getByRole('application');
    // The terminal's bottom (its input line) ends at 700 px: behind the keyboard once it opens.
    host.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    await waitFor(() => expect(host.contains(document.activeElement)).toBe(true));
    return scrollIntoView;
  };

  it('keeps the input line above the phone keyboard and key bar while typing (PM-79)', () =>
    withViewport(true, async (viewport) => {
      const scrollIntoView = await mountFocused();
      viewport.height = 450;
      viewport.dispatchEvent(new Event('resize'));
      await waitFor(() =>
        expect(scrollIntoView).toHaveBeenCalledWith({ top: 254, behavior: 'instant' }),
      );
      expect(document.documentElement.hasAttribute('data-terminal-typing')).toBe(true);
      scrollIntoView.mockClear();
      viewport.dispatchEvent(new Event('scroll'));
      expect(scrollIntoView).not.toHaveBeenCalled();
      // Keyboard closed: the tab bar comes back.
      viewport.height = 800;
      viewport.dispatchEvent(new Event('resize'));
      await waitFor(() =>
        expect(document.documentElement.hasAttribute('data-terminal-typing')).toBe(false),
      );
    }));

  it('never takes a shorter desktop window for an on-screen keyboard (PM-96)', () =>
    withViewport(false, async (viewport) => {
      const scrollIntoView = await mountFocused();
      viewport.height = 450; // Un-maximized, or DevTools opened.
      viewport.dispatchEvent(new Event('resize'));
      await new Promise((r) => setTimeout(r, 20));
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(document.documentElement.hasAttribute('data-terminal-typing')).toBe(false);
    }));

  it('restores keyboard focus when a preserved project terminal becomes visible again', async () => {
    const props = { fetchOutput: noFetch, streamUrl: () => '/stream', onInput: () => {} };
    const { rerender } = render(<TerminalView {...props} paused />);
    await waitFor(() => expect(terms[0]?.element).toBeTruthy());
    const host = screen.getByRole('application');
    expect(host.contains(document.activeElement)).toBe(false);
    rerender(<TerminalView {...props} paused={false} />);
    await waitFor(() => expect(host.contains(document.activeElement)).toBe(true));
  });

  it('reveals restored history only after parsing the final chunk and jumping to the prompt', async () => {
    render(<TerminalView fetchOutput={noFetch} streamUrl={() => '/stream'} historyBytes={10} />);
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    const host = screen.getByRole('log', { hidden: true });
    const term = terms.at(-1)!;
    expect(host.style.visibility).toBe('hidden');
    FakeEventSource.last!.emit('output', { data: 'first', nextOffset: 5 });
    term.pendingWrites.shift()!();
    expect(host.style.visibility).toBe('hidden');
    FakeEventSource.last!.emit('output', { data: 'last!', nextOffset: 10 });
    expect(host.style.visibility).toBe('hidden');
    term.pendingWrites.shift()!();
    expect(term.bottomScrolls).toBe(1);
    await waitFor(() => expect(host.style.visibility).toBe(''));
    FakeEventSource.last!.emit('output', { data: 'live', nextOffset: 14 });
    expect(term.bottomScrolls).toBe(1);
  });
  it('replays stopped terminals at recorded geometry without resizing the stopped process', async () => {
    const onResize = vi.fn();
    render(
      <TerminalView
        fetchOutput={noFetch}
        streamUrl={() => '/stream'}
        stopped
        onResize={onResize}
      />,
    );
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    const term = terms.at(-1)!;
    expect([term.cols, term.rows]).toEqual([120, 30]);
    FakeEventSource.last!.emit('output', {
      data: 'legacy',
      nextOffset: 6,
      terminalSize: { cols: 320, rows: 30 },
    });
    expect([term.cols, term.rows]).toEqual([320, 30]);
    expect(term.geometryHandler!('pm-size;180;42')).toBe(true);
    expect([term.cols, term.rows]).toEqual([180, 42]);
    term.geometryHandler!('pm-size;9999;42');
    expect(term.cols).toBe(180);
    expect(onResize).not.toHaveBeenCalled();
  });

  it('consumes geometry markers without resizing a live viewer', async () => {
    render(<TerminalView fetchOutput={noFetch} streamUrl={() => '/stream'} />);
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    const term = terms.at(-1)!;
    term.geometryHandler!('pm-size;180;42');
    expect([term.cols, term.rows]).toEqual([80, 24]);
  });
  it('stays where you scrolled while output streams in, and follows again at the bottom (PM-96)', async () => {
    const { container } = render(
      <TerminalView fetchOutput={noFetch} streamUrl={() => '/s'} onInput={() => {}} />,
    );
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    const term = terms.at(-1)!;
    const host = container.querySelector('.terminal')!;
    const viewport = document.createElement('div');
    viewport.className = 'xterm-viewport';
    Object.defineProperties(viewport, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 200 },
    });
    term.element!.appendChild(viewport);
    let offset = 0;
    const output = () => {
      offset += 4;
      FakeEventSource.last!.emit('output', { data: 'busy', nextOffset: offset });
      term.pendingWrites.shift()?.();
    };
    // Focused (as on desktop nearly always) and reading back with the wheel.
    expect(host.contains(document.activeElement)).toBe(true);
    viewport.scrollTop = 300;
    host.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    viewport.dispatchEvent(new Event('scroll'));
    const before = term.bottomScrolls;
    output();
    output();
    expect(term.bottomScrolls).toBe(before); // Not yanked back down.
    // Back at the bottom: following the output again.
    viewport.scrollTop = 800;
    viewport.dispatchEvent(new Event('scroll'));
    output();
    expect(term.bottomScrolls).toBe(before + 1);
  });

  it('streams live output, ignores replays after a reconnect, and forwards keystrokes', async () => {
    const onInput = vi.fn();
    render(
      <TerminalView
        fetchOutput={noFetch}
        streamUrl={(after) => `/stream?after=${after}`}
        onInput={onInput}
      />,
    );
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    expect(FakeEventSource.last!.url).toBe('/stream?after=0');
    const term = terms.at(-1)!;
    expect(term.options.disableStdin).toBe(false);

    FakeEventSource.last!.emit('output', { data: 'hello', nextOffset: 5 });
    FakeEventSource.last!.emit('output', { data: 'hello', nextOffset: 5 }); // Replay: ignored.
    FakeEventSource.last!.emit('output', { data: ' world', nextOffset: 11 });
    expect(term.written).toBe('hello world');

    term.onDataCb!('ls\r');
    expect(onInput).toHaveBeenCalledWith('ls\r');
  });

  it('leaves Ctrl+V to the browser paste, and sends ^V only when nothing was pasted', async () => {
    const onInput = vi.fn();
    const { container } = render(
      <TerminalView fetchOutput={noFetch} streamUrl={() => '/s'} onInput={onInput} />,
    );
    await waitFor(() => expect(terms.at(-1)?.keyHandler).not.toBeNull());
    const term = terms.at(-1)!;
    const ctrlV = () => term.keyHandler!(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }));
    // Text on the clipboard: the browser paste event carries it, nothing extra is sent.
    expect(ctrlV()).toBe(false);
    const paste = new Event('paste', { bubbles: true }) as Event & { clipboardData: unknown };
    paste.clipboardData = { getData: () => 'hello' };
    container.querySelector('.terminal')!.dispatchEvent(paste);
    await new Promise((r) => setTimeout(r, 80));
    expect(onInput).not.toHaveBeenCalled();
    // Nothing pasted (empty or image-only clipboard): ^V goes to the CLI.
    expect(ctrlV()).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(onInput).toHaveBeenCalledWith('\x16');
    // Other keys are untouched.
    expect(term.keyHandler!(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))).toBe(true);
  });

  it('polls read-only output until the finished process is drained', async () => {
    const fetchOutput = vi
      .fn<(after: number) => Promise<AgentOutput>>()
      .mockResolvedValueOnce({
        data: 'done\n',
        nextOffset: 5,
        running: false,
        exitCode: 0,
        logBytes: 5,
      })
      .mockResolvedValue({ data: '', nextOffset: 5, running: false, exitCode: 0, logBytes: 5 });
    render(<TerminalView fetchOutput={fetchOutput} />);
    await waitFor(() => expect(terms.at(-1)?.written).toBe('done\n'));
    expect(terms.at(-1)!.options.disableStdin).toBe(true);
    await waitFor(() => expect(fetchOutput).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 400));
    expect(fetchOutput).toHaveBeenCalledTimes(2); // Stopped: nothing more to read.
  });

  it('applies a new font size live without re-creating the terminal', async () => {
    const props = { fetchOutput: noFetch, streamUrl: () => '/s', onInput: () => undefined };
    const { rerender } = render(<TerminalView {...props} fontSize={12.5} />);
    await waitFor(() => expect(terms.length).toBeGreaterThan(0));
    const count = terms.length;
    rerender(<TerminalView {...props} fontSize={15} />);
    expect(terms.length).toBe(count);
    expect(terms.at(-1)!.options.fontSize).toBe(15);
  });

  it('scrolls the whole normal terminal on touch and preserves alternate-screen wheel handling', async () => {
    const { container } = render(
      <TerminalView fetchOutput={noFetch} streamUrl={() => '/s'} onInput={() => undefined} />,
    );
    await waitFor(() => expect(terms.at(-1)?.element).toBeDefined());
    const wheels: number[] = [];
    terms.at(-1)!.element!.addEventListener('wheel', (e) => wheels.push(e.deltaY));
    const host = container.querySelector('.terminal')!;
    const touch = (type: string, y: number | null) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', {
        value: y === null ? [] : [{ clientX: 10, clientY: y }],
      });
      host.dispatchEvent(event);
      return event;
    };
    touch('touchstart', 100);
    const move = touch('touchmove', 140); // Finger down: back through the history.
    touch('touchmove', 120); // Finger up: forward again.
    touch('touchend', null);
    await waitFor(() => expect(terms.at(-1)!.scrolled).toEqual([-1]));
    expect(wheels).toEqual([]);
    expect(move.defaultPrevented).toBe(true); // The page around it doesn't scroll instead.
    terms.at(-1)!.buffer.active.type = 'alternate';
    touch('touchstart', 100);
    touch('touchmove', 140);
    touch('touchmove', 120);
    touch('touchend', null);
    expect(wheels).toEqual([-40, 20]);
  });

  it('sends a pasted or dropped image as a file and pastes text through xterm', async () => {
    const onImage = vi.fn();
    const onInput = vi.fn();
    const pasteRef = { current: null as ((text: string) => void) | null };
    const { container } = render(
      <TerminalView
        fetchOutput={noFetch}
        streamUrl={() => '/s'}
        onInput={onInput}
        onImage={onImage}
        pasteRef={pasteRef}
      />,
    );
    await waitFor(() => expect(terms.at(-1)?.keyHandler).not.toBeNull());
    const term = terms.at(-1)!;
    const image = new File(['x'], 'shot.png', { type: 'image/png' });
    // Ctrl+V with only an image on the clipboard: the image goes to onImage, no ^V fallback.
    term.keyHandler!(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }));
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
      clipboardData: unknown;
    };
    paste.clipboardData = { getData: () => '', files: [image] };
    container.querySelector('.terminal')!.dispatchEvent(paste);
    await new Promise((r) => setTimeout(r, 80));
    expect(onImage).toHaveBeenCalledWith(image);
    expect(onInput).not.toHaveBeenCalled();
    expect(paste.defaultPrevented).toBe(true);
    // The uploaded image's path goes in as a paste (bracketed when the CLI asked for it).
    pasteRef.current!('/data/attachments/shot.png');
    expect(term.pasted).toBe('/data/attachments/shot.png');
  });
});

it('sends mobile shortcut sequences and expands extra desktop keys', () => {
  const onInput = vi.fn();
  render(
    <TerminalView
      fetchOutput={async () => ({
        data: '',
        nextOffset: 0,
        running: false,
        exitCode: 0,
        logBytes: 0,
      })}
      onInput={onInput}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Escape' }));
  fireEvent.click(screen.getByRole('button', { name: 'Arrow up' }));
  expect(onInput.mock.calls.map((call) => call[0])).toEqual(['\x1b', '\x1b[A']);
  fireEvent.click(screen.getByRole('button', { name: 'Control A' }));
  expect(onInput).toHaveBeenLastCalledWith('\x01');
  fireEvent.click(screen.getByRole('button', { name: 'Interrupt (Control C)' }));
  expect(screen.queryByRole('button', { name: 'More terminal keys' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Function keys' }));
  fireEvent.click(screen.getByRole('button', { name: 'Function 12' }));
  expect(onInput.mock.calls.slice(-2).map((call) => call[0])).toEqual(['\x03', '\x1b[24~']);
});

it('keeps downward touch movement continuous when xterm rounds its viewport', async () => {
  const { container } = render(
    <TerminalView
      fetchOutput={async () => ({
        data: '',
        nextOffset: 0,
        running: false,
        exitCode: 0,
        logBytes: 0,
      })}
      onInput={() => undefined}
    />,
  );
  await waitFor(() => expect(terms.at(-1)?.element).toBeDefined());
  const host = container.querySelector('.terminal')!;
  const viewport = document.createElement('div');
  viewport.className = 'xterm-viewport';
  Object.defineProperties(viewport, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 200 },
  });
  viewport.scrollTop = 200;
  terms.at(-1)!.element!.appendChild(viewport);
  const touch = (type: string, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: [{ clientX: 10, clientY: y }] });
    host.dispatchEvent(event);
  };
  touch('touchstart', 100);
  touch('touchmove', 94);
  await waitFor(() => expect(viewport.scrollTop).toBe(206));
  viewport.scrollTop = 200; // Renderer synchronizes to the nearest terminal row.
  touch('touchmove', 88);
  await waitFor(() => expect(viewport.scrollTop).toBe(212));
  touch('touchmove', -1000);
  await waitFor(() => expect(viewport.scrollTop).toBe(800));
  touch('touchcancel', 0);
});

it('automatically scrolls to the bottom when user types in an interactive terminal', async () => {
  const onInput = vi.fn();
  render(
    <TerminalView
      fetchOutput={async () => ({
        data: '',
        nextOffset: 0,
        running: true,
        exitCode: null,
        logBytes: 0,
      })}
      streamUrl={() => '/stream'}
      onInput={onInput}
    />,
  );
  await waitFor(() => expect(terms.at(-1)?.onDataCb).toBeDefined());
  const term = terms.at(-1)!;
  const initialScrolls = term.bottomScrolls;
  term.onDataCb?.('ls\r');
  expect(term.bottomScrolls).toBeGreaterThan(initialScrolls);
  expect(onInput).toHaveBeenCalledWith('ls\r');
});

it('tails large history logs exceeding MAX_INITIAL_HISTORY_BYTES and strips broken leading line', async () => {
  const streamUrl = vi.fn((after: number) => `/stream?after=${after}`);
  const largeHistory = 1024 * 1024; // 1 MB > 512 KB MAX_INITIAL_HISTORY_BYTES
  const expectedOffset = largeHistory - MAX_INITIAL_HISTORY_BYTES;

  render(<TerminalView fetchOutput={noFetch} streamUrl={streamUrl} historyBytes={largeHistory} />);

  await waitFor(() => expect(streamUrl).toHaveBeenCalledWith(expectedOffset));
  expect(FakeEventSource.last?.url).toBe(`/stream?after=${expectedOffset}`);

  act(() => {
    FakeEventSource.last?.emit('output', {
      data: 'broken-leading-fragment\nclean line 1\nclean line 2\n',
      nextOffset: largeHistory,
    });
  });

  const term = terms.at(-1)!;
  expect(term.written).toContain('clean line 1\nclean line 2\n');
  expect(term.written).not.toContain('broken-leading-fragment\n');
});
