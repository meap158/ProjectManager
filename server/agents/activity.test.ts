import { describe, expect, it } from 'vitest';
import {
  animatingInTail,
  backgroundInTail,
  elapsedTimer,
  stripTerminal,
  tailState,
  timerTicking,
  workingInTail,
  type TimerMemo,
} from './activity.js';

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

  it('OpenCode mid-task with esc interrupt is running, and idle when prompt has no interrupt', () => {
    const running = [
      'Build · Claude Opus 5.5 Anthropic',
      '■⬝⬝⬝⬝⬝⬝⬝  esc interrupt                                                     434.6K (43%) · $20.59  ctrl+p commands',
    ].join('\n');
    expect(tailState(running)).toBe('running');
    expect(workingInTail(running)).toBe(true);

    const idle = [
      'S:\\Vibe Coding\\TiemNet',
      '486.1K (49%) · $18.22  ctrl+p commands    • OpenCode 1.19.0',
    ].join('\n');
    expect(tailState(idle)).toBe('idle');
    expect(workingInTail(idle)).toBe(false);
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
    // Codex paused-goal overlay and usage-limit goal footer (PM-165).
    expect(
      tailState(
        'Resume paused goal?\n› 1. Resume goal   Mark it active and continue when idle\n  2. Leave paused  Keep it paused; use /goal resume later\n› Ask Codex to do anything   enter select · esc back\nGoal hit usage limits (/goal resume)',
      ),
    ).toBe('input');
    expect(
      tailState(
        '■ You’ve hit your usage limit.\n› Ask Codex to do anything\nGoal hit usage lim ts (/goal resume',
      ),
    ).toBe('input');
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

describe('busy-line timer (PM-67)', () => {
  it('reads Codex and Claude timers, the last one on screen, with their step', () => {
    expect(elapsedTimer('• Working (8m 05s • esc to interrupt)')).toEqual({
      seconds: 485,
      step: 1,
    });
    expect(elapsedTimer('✻ Tinkering… (3m 22s · ↓ 12k tokens)')).toEqual({ seconds: 202, step: 1 });
    expect(elapsedTimer('Working (2s • esc)\n…\nWorking (9s • esc)')).toEqual({
      seconds: 9,
      step: 1,
    });
    expect(elapsedTimer('✻ Pondering… (1h 2m · thinking)')).toEqual({ seconds: 3720, step: 60 });
    expect(elapsedTimer('✻ Worked for 3m 12s\n❯ ')).toBeNull();
  });

  it('ticking only when the timer moves; typing alone never counts', () => {
    const memo: TimerMemo = new Map();
    const at = (s: number) => ({ seconds: s, step: 1 });
    expect(timerTicking(memo, 1, at(10), 0)).toBeNull(); // First look: nothing to compare.
    expect(timerTicking(memo, 1, at(14), 4_000)).toBe(true); // Moved: working.
    expect(timerTicking(memo, 1, at(14), 6_000)).toBe(true); // Same value, within its step.
    // Frozen (the turn stopped; only the input box changes as you type): not working.
    expect(timerTicking(memo, 1, at(14), 13_000)).toBe(false);
    expect(timerTicking(memo, 1, null, 14_000)).toBeNull(); // Timer gone.
    expect(memo.has(1)).toBe(false);
  });

  it('a minutes-only timer gets a minute before it counts as frozen', () => {
    const memo: TimerMemo = new Map();
    timerTicking(memo, 2, { seconds: 3720, step: 60 }, 0);
    timerTicking(memo, 2, { seconds: 3780, step: 60 }, 60_000);
    expect(timerTicking(memo, 2, { seconds: 3780, step: 60 }, 110_000)).toBe(true);
    expect(timerTicking(memo, 2, { seconds: 3780, step: 60 }, 130_000)).toBe(false);
  });
});

describe('busy animation in the newest output (PM-67)', () => {
  it("spots Claude's spinner frames and Codex's blinking timer (real log tails)", () => {
    expect(
      animatingInTail(
        'Alowed by auto mode classifier✶Crystallizing…4*✢Crystallizing…·Crystallizing…5',
      ),
    ).toBe(true);
    expect(animatingInTail('h•0◦4•◦5•6◦•7◦•8◦9•◦')).toBe(true);
    // Hyphenated spinner word, frames interleaved with the /goal footer (real tail, PM-78).
    expect(
      animatingInTail(
        '6m)*Fiddle-faddling…✶◎ /goal active (26m)6✻Fiddle-faddling…◎ /goal active (26m)✽Fiddle-faddling…',
      ),
    ).toBe(true);
    expect(animatingInTail('unter Strike | TiemNet•11◦•22◦33•◦44•')).toBe(true);
    // OpenCode progress bar dots and braille spinners
    expect(animatingInTail('⬝■■■■■⬝⬝⬝⬝■■■■⬝⬝⬝⬝⬝■■■⬝⬝⬝⬝⬝⬝■■')).toBe(true);
    expect(animatingInTail('⠦⠧⠇⠏⠋⠙⠹⠸⠼⠴')).toBe(true);
  });

  it('typing in the input box, or a finished list, is not animation', () => {
    expect(animatingInTail('> fix the login page so the button is cent')).toBe(false);
    expect(animatingInTail('• Committed six isolated changes\n• Stopped editing files\n› ')).toBe(
      false,
    );
    expect(animatingInTail('✻ Worked for 3m 12s\n❯ ')).toBe(false);
  });
});

describe('background work on screen (PM-104)', () => {
  it("counts Claude's background agents and shells, even after the main turn ended", () => {
    // The owner's screenshot: the main turn is done (prompt shown), two agents still run.
    const screen = [
      '* Waiting for 2 background agents to',
      '  finish',
      '────────────────────────────────',
      '> ',
      '────────────────────────────────',
      '  ▸▸ auto mode on (shift+tab to cycle)',
      '  ● main',
      '  ( ) general-purpose 6m 16s · ↓ 113.8k',
      '  ( ) general-purpose t6m 16s · ↓ 96.9k',
    ].join('\n');
    expect(backgroundInTail(screen)).toBe(true);
    // Only the agent list, no "waiting" line.
    expect(backgroundInTail('> \n  ● main\n  ( ) general-purpose 2m 03s · ↓ 12.1k')).toBe(true);
    expect(backgroundInTail('✻ Worked for 3m 12s · 1 shell still running\n❯ ')).toBe(true);
    // A finished turn with nothing in the background.
    expect(backgroundInTail('✻ Churned for 54m 43s · done\n❯ \n⏵⏵ auto mode on · ← 1 agent')).toBe(
      false,
    );
  });
});
