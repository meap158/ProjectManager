// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { inferTerminalGeometry, legacyTerminalSnapshot } from './terminalGeometry';

describe('legacy terminal geometry', () => {
  it('recovers the latest complete legacy redraw instead of overlaying obsolete screen sizes', async () => {
    const frame =
      '\x1b[H' +
      (' '.repeat(159) + '\x1b[K').repeat(30) +
      '\x1b[HLatest conversation\x1b[5;120HContext';
    const snapshot = legacyTerminalSnapshot('\x1b[2;319Hobsolete wide frame' + frame);
    expect(snapshot).not.toBeNull();
    expect(snapshot).not.toContain('obsolete');
    const term = new Terminal({ cols: 120, rows: 30 });
    term.parser.registerOscHandler(777, (data) => {
      const match = /^pm-size;(\d+);(\d+)$/.exec(data);
      if (match) term.resize(Number(match[1]), Number(match[2]));
      return true;
    });
    try {
      await new Promise<void>((resolve) => term.write(snapshot!, resolve));
      expect(term.cols).toBe(159);
      expect(term.buffer.active.getLine(0)!.translateToString(true).trimEnd()).toBe(
        'Latest conversation',
      );
      expect(term.buffer.active.getLine(4)!.translateToString(true).slice(119).trimEnd()).toBe(
        'Context',
      );
    } finally {
      term.dispose();
    }
    expect(legacyTerminalSnapshot('ordinary text')).toBeNull();
    const filled = '\x1b[H' + ('Latest content'.padEnd(159) + '\x1b[K').repeat(30);
    expect(legacyTerminalSnapshot(filled)).toContain('pm-size;159;30');
    expect(legacyTerminalSnapshot('\x1b]777;pm-size;120;30\x07' + frame)).toBeNull();
  });
  it('keeps a wide stopped full-screen display intact with the real ANSI parser', async () => {
    const data = '\x1b[2J\x1b[H\x1b[2;1HConversation\x1b[2;250HContext\x1b[20;319H||';
    const size = inferTerminalGeometry(data);
    expect(size).toEqual({ cols: 320, rows: 30 });
    const term = new Terminal(size);
    try {
      await new Promise<void>((resolve) => term.write(data, resolve));
      expect(term.buffer.active.getLine(1)!.translateToString(true)).toContain('Context');
      expect(term.buffer.active.getLine(19)!.translateToString(true).slice(318)).toBe('||');
      expect(term.buffer.active.getLine(20)!.translateToString(true)).toBe('');
    } finally {
      term.dispose();
    }
  });

  it('counts text through colour changes, bounds sizes, and defaults plain logs', () => {
    expect(inferTerminalGeometry('plain output')).toEqual({ cols: 120, rows: 30 });
    expect(inferTerminalGeometry('\x1b[40;319H\x1b[31mAB\x1b[0m')).toEqual({ cols: 320, rows: 40 });
    expect(inferTerminalGeometry('\x1b[999;999Habc')).toEqual({ cols: 500, rows: 500 });
  });
});
