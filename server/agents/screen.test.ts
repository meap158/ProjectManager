import { describe, expect, it } from 'vitest';
import { renderScreen } from './screen.js';

describe('renderScreen (PM-129)', () => {
  it("keeps Claude Code's spinner word in place instead of repeating it", () => {
    // Claude Code's frames, as logged: the glyph at row 2, then the word one cell on.
    const frames =
      '\x1b[2;1H\u273b\x1b[1CRoosting\u2026\x1b[38;2;153;153;153m\x1b[1C(14m 57s)\x1b[m\x1b[4;3H' +
      '\x1b[?25l\x1b[2;1H\u2736\x1b[4;3H\x1b[?25h' +
      '\x1b[38;2;235;159;127m\x1b[2;3HRo\x1b[38;2;215;119;87mosting\u2026\x1b[4;3H' +
      '\x1b]0;\u25d1 Title\x07\x1b[2;1H\u00b7\x1b[1CRoosting\u2026\x1b[4;3H';
    const lines = renderScreen(frames, 40, 5);
    expect(lines[1]).toBe('\u00b7 Roosting\u2026 (14m 57s)');
    expect(lines.join('\n')).not.toMatch(/Roosting.*Roosting/);
  });

  it('keeps lines scrolled off a small screen as scrollback, until a full clear', () => {
    const menu = 'Pick one?\r\n1. Shop card\r\n2. Campaign table\r\n3. Both\r\nEnter to select';
    // Three rows: the question and option 1 scroll off the top.
    expect(renderScreen(menu, 20, 3)).toEqual(['2. Campaign table', '3. Both', 'Enter to select']);
    expect(renderScreen(menu, 20, 3, false, 50)).toEqual([
      'Pick one?',
      '1. Shop card',
      '2. Campaign table',
      '3. Both',
      'Enter to select',
    ]);
    // A full clear starts a new frame: the old overflow is gone.
    expect(renderScreen(`${menu}\x1b[2J\x1b[Hnew`, 20, 3, false, 50)).toEqual(['new', '', '']);
  });

  it('consumes CSI sequences with a private prefix ("ESC [ < u") instead of drawing them', () => {
    expect(renderScreen('❯ \x1b[<u\x1b[<u', 10, 1)).toEqual(['❯']);
  });

  it('erases, wraps and scrolls like a terminal', () => {
    expect(renderScreen('abcdef\r\x1b[2Cxy\x1b[K', 10, 2)).toEqual(['abxy', '']);
    expect(renderScreen('abcdefgh', 4, 2)).toEqual(['abcd', 'efgh']);
    expect(renderScreen('abcd\r\n', 4, 2)).toEqual(['abcd', '']); // No early wrap at the margin.
    expect(renderScreen('abcd\x1b[mef', 4, 2)).toEqual(['abcd', 'ef']); // Colours keep the wrap.
    expect(renderScreen('1\r\n2\r\n3\r\n4', 4, 2)).toEqual(['3', '4']);
    expect(renderScreen('\u4f60\u597dx', 10, 1)).toEqual(['\u4f60\u597dx']);
    expect(renderScreen('one\x1b[2J\x1b[Htwo', 10, 2)).toEqual(['two', '']);
  });

  it('starts at the first escape when the log was sliced mid-stream', () => {
    expect(renderScreen('8;2;1;2;3mjunk\x1b[1;1Hok', 10, 1, true)).toEqual(['ok']);
  });
});
