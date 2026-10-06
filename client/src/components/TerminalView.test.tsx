// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentOutput } from '../../../shared/types';
import { TerminalView } from './TerminalView';

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
      host.appendChild(this.element);
    }
    focus() {}
    dispose() {}
    write(data: string) {
      this.written += data;
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

  it('turns a vertical swipe into wheel scrolling (phones have no touch scrolling in xterm)', async () => {
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
    expect(wheels).toEqual([-40, 20]);
    expect(move.defaultPrevented).toBe(true); // The page around it doesn't scroll instead.
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
