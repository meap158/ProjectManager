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
    }[],
);
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    written = '';
    onDataCb: ((d: string) => void) | null = null;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      terms.push(this as never);
    }
    loadAddon() {}
    open() {}
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
});
