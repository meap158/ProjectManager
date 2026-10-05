import { describe, expect, it } from 'vitest';
import { isAwaitingInput, stripTerminal } from './activity.js';

const ESC = '\x1b';

describe('stripTerminal', () => {
  it('removes CSI/OSC sequences and folds lone carriage returns', () => {
    expect(stripTerminal(`${ESC}[2J${ESC}[Hhello${ESC}[?25l\rworld`)).toBe('hello\nworld');
    expect(stripTerminal(`${ESC}]0;title\x07kept`)).toBe('kept');
    expect(stripTerminal('a\r\nb')).toBe('a\r\nb');
  });
});

describe('isAwaitingInput', () => {
  it('sees a Codex session waiting at its prompt', () => {
    const tail = [
      `${ESC}[?25l${ESC}[2J${ESC}[H`,
      'GPT-6.1-Sol low · S:\\Vibe Coding\\ProjectManager · Address PM-5',
      '└─ Working (12m 04s · esc to interrupt) · 2 background terminals running',
      '› Ask Codex to do anything',
      '← for agents · ? for shortcuts',
      '⚠ 3 warnings · f2 to view',
    ].join('\r\n');
    expect(isAwaitingInput(tail)).toBe(true);
  });

  it('sees a Claude session waiting at a bare prompt', () => {
    expect(isAwaitingInput(`streaming some output here\n${ESC}[2K\r❯ `)).toBe(true);
  });

  it('stays working while output streams with no prompt in sight', () => {
    const tail = [
      '⠋ Working on the fix… (esc to interrupt)',
      'Reading server/agents/supervisor.ts … 1,204 lines read',
      'Applying the patch now',
    ].join('\n');
    expect(isAwaitingInput(tail)).toBe(false);
  });

  it('ignores an old prompt when newer busy output follows it', () => {
    const tail = ['› Ask Codex to do anything', 'Working (0m 03s · esc to interrupt)', '…'].join(
      '\n',
    );
    expect(isAwaitingInput(tail)).toBe(false);
  });

  it('says nothing for shells, empty logs, and unknown CLIs', () => {
    expect(isAwaitingInput('')).toBe(false);
    expect(isAwaitingInput('C:\\proj> dir\nfile1.txt\nC:\\proj> ')).toBe(false);
    expect(isAwaitingInput('some random output')).toBe(false);
  });
});
