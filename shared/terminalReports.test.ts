import { describe, expect, it } from 'vitest';
import { isTerminalReport, stripTerminalReports } from './terminalReports.js';

const ESC = '\x1b';
const ST = `${ESC}\\`;

describe('isTerminalReport', () => {
  it('recognises replies the terminal sends by itself', () => {
    for (const reply of [
      `${ESC}[?1;2c`, // device attributes
      `${ESC}[>0;276;0c`, // secondary device attributes
      `${ESC}[12;40R`, // cursor position report
      `${ESC}[0n`, // status report
      `${ESC}[I`, // focus in
      `${ESC}[O`, // focus out
      `${ESC}]11;rgb:1212/1212/1111${ST}`, // OSC colour reply
      `${ESC}]11;rgb:1212/1212/1111\x07`, // OSC colour reply, BEL-terminated
      `${ESC}P>|xterm.js(5.5.0)${ST}`, // XTVERSION reply
      `${ESC}[I${ESC}[?1;2c`, // several at once
    ]) {
      expect(isTerminalReport(reply), JSON.stringify(reply)).toBe(true);
    }
  });

  it('never swallows real typing', () => {
    for (const typed of [
      'a',
      'hello\r',
      '\r',
      '\x03', // Ctrl+C
      `${ESC}[A`, // arrow up
      `${ESC}[1;5C`, // Ctrl+arrow right
      '\x7f', // backspace
      'ls -la\r',
      `${ESC}[200~pasted${ESC}[201~`, // bracketed paste
    ]) {
      expect(isTerminalReport(typed), JSON.stringify(typed)).toBe(false);
    }
  });
});

describe('stripTerminalReports', () => {
  it('removes replies mixed into queued input and keeps the typing', () => {
    const queued = `${ESC}[I${ESC}[?1;2cgit status\r${ESC}[12;40R${ESC}[O`;
    expect(stripTerminalReports(queued)).toBe('git status\r');
    expect(stripTerminalReports(`${ESC}[A\r`)).toBe(`${ESC}[A\r`);
  });
});
