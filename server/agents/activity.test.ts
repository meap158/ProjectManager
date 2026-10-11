import { describe, expect, it } from 'vitest';
import { stripTerminal, tailState, workingInTail } from './activity.js';

const ESC = '\x1b';

describe('stripTerminal', () => {
  it('removes CSI/OSC sequences and folds lone carriage returns', () => {
    expect(stripTerminal(`${ESC}[2J${ESC}[Hhello${ESC}[?25l\rworld`)).toBe('hello\nworld');
    expect(stripTerminal(`${ESC}]0;title\x07kept`)).toBe('kept');
    expect(stripTerminal('a\r\nb')).toBe('a\r\nb');
  });
});

/** One Codex frame: status line (if any), then its always-visible input box. */
const codexFrame = (status: string) =>
  [
    `${ESC}[?25l${ESC}[2J${ESC}[H`,
    'GPT-6.1-Sol low · S:\\Vibe Coding\\ProjectManager · Address PM-5',
    status,
    '› Ask Codex to do anything',
    '← for agents · ? for shortcuts',
  ].join('\r\n');

describe('tailState', () => {
  it('Codex mid-task is running even though its input box is drawn (PM-14)', () => {
    const tail = codexFrame(
      '└─ Working (12m 04s · esc to interrupt) · 2 background terminals running',
    );
    expect(tailState(tail)).toBe('running');
  });

  it('Codex waiting with background terminals still going is running (PM-14)', () => {
    const tail = codexFrame('Waiting for background terminal · 2 background terminals running');
    expect(tailState(tail)).toBe('running');
  });

  it('Codex finished: an older busy frame followed by a quiet frame is idle', () => {
    const tail =
      codexFrame('└─ Working (0m 41s · esc to interrupt)') + codexFrame('└─ Worked for 0m 42s');
    expect(tailState(tail)).toBe('idle');
  });

  it('Claude at its prompt is idle, but running while a background shell or agent is going', () => {
    expect(tailState(`streaming some output here\n${ESC}[2K\r❯ `)).toBe('idle');
    expect(tailState('● Every game builds.\n✻ Worked for 1h 25m · 1 shell still running\n❯ ')).toBe(
      'running',
    );
    expect(tailState('✻ Waiting for 2 background agents to finish\n❯ \n'.replace(/\n$/, ''))).toBe(
      'running',
    );
  });

  it('Claude idle with the leftover "← 1 agent" footer hint is idle (owner report)', () => {
    const footer =
      '✻ Churned for 54m 43s · done\n❯ \n⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent';
    expect(tailState(footer)).toBe('idle');
  });

  it('Antigravity and Grok at their prompt are idle', () => {
    const agyTail = '────────────────────────────\n>\n────────────────────────────\nesc to cancel';
    expect(tailState(agyTail)).toBe('idle');
    const grokTail =
      '╭──────────────────────────╮\n│ >                        │\n╰──────────────────────────╯';
    expect(tailState(grokTail)).toBe('idle');
  });

  it('busy phrases still match when redraws run the words together', () => {
    expect(tailState('✻ Zigzagging… (esctointerrupt)\n❯ ')).toBe('running');
    expect(tailState('✻ Worked for 3m ·1shellstill running\n❯ ')).toBe('running');
  });

  it('Grok idle: a tail that only redraws its braille logo is idle, not running', () => {
    const logo = '⣀⣀⡀⠀⠀⠀⢀⠄⠀⠀⠀⣠⣾⠿⠛⠛⠛⠛⢀⡴⠁⠀⠀⠀⣼⡟⠁';
    const tail = Array.from({ length: 40 }, () => `${ESC}[38;2;114;114;114m${logo}${ESC}[H`).join(
      '',
    );
    expect(tailState(tail)).toBe('idle');
    // Busy Grok prints words: back to the recency fallback.
    expect(
      tailState(`${tail}
${ESC}[0mThinking…`),
    ).toBeNull();
  });

  it('a busy stream with no prompt in sight says nothing (recency decides)', () => {
    const tail = [
      '⠋ Working on the fix… (esc to interrupt)',
      'Reading server/agents/supervisor.ts … 1,204 lines read',
      'Applying the patch now',
    ].join('\n');
    expect(tailState(tail)).toBeNull();
  });

  it('says nothing for shells, empty logs, and unknown CLIs', () => {
    expect(tailState('')).toBeNull();
    expect(tailState('C:\\proj> dir\nfile1.txt\nC:\\proj> ')).toBeNull();
    expect(tailState('some random output')).toBeNull();
  });

  it('a choice the CLI asks you to make needs your input (PM-47)', () => {
    // Claude Code permission prompt.
    const claude =
      'Edit file src/app.ts\n Do you want to make this edit to app.ts?\n ❯ 1. Yes\n   2. Yes, allow all edits during this session (shift+tab)\n   3. No, and tell Claude what to do differently (esc)\n';
    expect(tailState(claude)).toBe('input');
    // Codex approval.
    const codex =
      'Allow command?\n › 1. Yes, proceed (y)\n   2. No, and tell Codex what to do differently (esc)\n Press enter to confirm or esc to cancel';
    expect(tailState(codex)).toBe('input');
    // Grok menu (radio buttons, key hints) and Antigravity's trust question.
    expect(
      tailState('1 (○) Upgrade tier\n2 (○) Buy more credits\n↑/↓ navigate · Enter:submit'),
    ).toBe('input');
    expect(tailState('> Yes, I trust this folder\n  No, exit  ↑/↓ Navigate · enter Confirm')).toBe(
      'input',
    );
  });

  it('plain numbered lists in an answer are not a choice', () => {
    expect(tailState('Steps:\n1. Install\n2. Run tests\n❯ ')).toBe('idle');
  });

  it('spots Claude\'s working line (newer versions drop "esc to interrupt")', () => {
    expect(
      workingInTail('● Reading files\n✱ Tinkering… (3m 22s · ↓ 12.1k tokens · thinking)\n❯ '),
    ).toBe(true);
    expect(workingInTail('✻ Worked for 3m 12s\n❯ ')).toBe(false);
  });
});
