import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminalInput } from './terminalInput.js';

afterEach(() => vi.useRealTimers());

describe('terminal input submission', () => {
  it('lets a multiline paste settle before sending Enter automatically', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const input = terminalInput(write);
    const paste = '\x1b[200~Task PM-8\n\nFix the flow\x1b[201~';
    input.write(`${paste}\r`);
    expect(write.mock.calls).toEqual([[paste]]);
    vi.advanceTimersByTime(499);
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(write.mock.calls).toEqual([[paste], ['\r']]);
  });

  it('also delays Enter arriving in a separate write and preserves input order', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const input = terminalInput(write);
    input.write('\x1b[200~task\x1b[201~');
    input.write('\r');
    input.write('next');
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(write.mock.calls).toEqual([['\x1b[200~task\x1b[201~'], ['\r'], ['next']]);
  });

  it('cancels pending submission when the process exits', () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const input = terminalInput(write);
    input.write('\x1b[200~task\x1b[201~\r');
    input.close();
    vi.runAllTimers();
    expect(write).toHaveBeenCalledTimes(1);
    expect(input.write('late')).toBe(false);
  });
});
