// Decides what an agent CLI is doing by reading its log tail.
//
// Why this exists: "running" used to mean "the log file changed recently", but TUI status
// redraws (elapsed timers, spinners) keep the file fresh for hours while the agent waits.
// Conversely, Codex and Claude Code draw their input box on every frame, even mid-task, so
// "a prompt is on screen" doesn't mean idle either. What counts is the *last frame* (the text
// between the last two prompt draws): busy chrome or a still-running background job there
// means running (owner rule PM-14: a shell or subtask the session started keeps it running);
// a prompt with neither means the agent is waiting for you. A choice the CLI asks you to make
// (a numbered list with a cursor, "Enter to confirm") is its own state: it needs your input.

export type TailState = 'running' | 'idle' | 'input';

/** The vendors' own input prompts (tested against real terminal dumps). */
const PROMPT_PATTERNS = [
  // Codex: "Ask Codex to do anything" placeholder in its input line.
  /ask\s+\S+\s+to\s+do\s+anything/gi,
  // Claude Code: a bare ❯ prompt as the last thing on a line.
  /❯[ \t]*$/gm,
  // Antigravity & Grok: bare > prompt (alone on a line or bounded by box borders │)
  /^[ \t│]*>[ \t│]*$/gm,
  // Antigravity input hint below the prompt line
  /esc\s*to\s*cancel/gi,
];

/** The CLI is working on a turn right now. */
// Spacing is optional throughout: full-screen CLIs redraw with cursor moves, so the log often
// holds words run together ("esctointerrupt").
const BUSY_PATTERNS = [/esc\s*to\s*interrupt/i, /working\s*\(\s*\d+[smh]/i];

/**
 * A live "working" line: Claude Code's spinner word with its timer ("Tinkering… (3m 22s · ↓ 12k
 * tokens"), which newer versions show without "esc to interrupt". Old frames linger in the log,
 * so callers only trust this together with fresh output (see workingInTail).
 */
const WORKING_LINE = /…\s*\(\s*\d+[smh]\b/;

/**
 * The CLI asks you to pick something: an option list with a cursor on "1." (Claude ❯, Codex ›,
 * Antigravity >), or the menus' own key hints, radio buttons, yes/no questions.
 */
const CHOICE_PATTERNS = [
  /[❯›>]\s*1\.\s*\S[^\n]*\n[^\n]*\b2\.\s*\S/,
  /press\s*enter\s*to\s*(?:confirm|select|continue)/i,
  /enter\s*(?:to\s*)?(?:select|confirm|submit)\b/i,
  /↑\s*\/\s*↓\s*(?:to\s*)?(?:navigate|select|choose)/i,
  /\((?:○|●)\)/,
  /[[(]\s*y\s*\/\s*n\s*[\])]/i,
];
/** Choices count only near the end of the tail (the current screen, not scrollback). */
const CHOICE_TAIL_CHARS = 900;

/** Something the session started is still going (background shells, terminals, subagents). */
const BACKGROUND_PATTERNS = [
  /\b\d+\s*background\s*(?:terminals?|shells?|agents?|tasks?)\s*running/i,
  /waiting\s*for\s*\d+\s*background/i,
  /\b\d+\s*shells?\s*still\s*running/i,
  // Claude Code's footer: "auto mode on · 1 shell · ↓ to manage". (Its "← 1 agent" hint stays
  // after the agent finished, so it is not a signal.)
  /·\s*\d+\s*shells?\s*·/,
];

/** The last frame is at most this long when only one prompt draw is in the tail. */
const FRAME_CHARS = 1200;
/** A prompt only counts when it sits within this many chars of the tail end. */
const PROMPT_TAIL_CHARS = 480;

/** Strips ANSI escapes (CSI, OSC, charset selects) and carriage returns. */
/* eslint-disable no-control-regex -- matching terminal escape sequences requires control chars */
export function stripTerminal(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|$)/g, '')
    .replace(/\x1b[()][0-9A-B]/g, '')
    .replace(/\r(?!\n)/g, '\n');
}
/* eslint-enable no-control-regex */

/** Start offsets of every prompt draw, in order. */
function promptOffsets(text: string): number[] {
  const found: number[] = [];
  for (const pattern of PROMPT_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (let m = re.exec(text); m; m = re.exec(text)) found.push(m.index);
  }
  return found.sort((a, b) => a - b);
}

/**
 * What the CLI is doing according to its log tail, or null when the tail says nothing (shells,
 * custom commands, unknown CLIs, no recent prompt): callers then fall back to output recency.
 */
export function tailState(logTail: string): TailState | null {
  const text = stripTerminal(logTail);
  // Pure animation (e.g. Grok's idle welcome screen redraws a braille logo forever): a tail with
  // no letters or digits at all is redraw chrome, not work. Busy CLIs always print words.
  const words = text.replace(/[⠀-⣿─-▟\s]/g, '');
  if (text.trim().length > 0 && !/[\p{L}\p{N}]/u.test(words)) return 'idle';
  // A choice on screen, with no turn running below it, needs you.
  const end = text.slice(-CHOICE_TAIL_CHARS);
  if (CHOICE_PATTERNS.some((p) => p.test(end)) && !BUSY_PATTERNS.some((p) => p.test(end))) {
    return 'input';
  }
  const prompts = promptOffsets(text);
  const last = prompts.at(-1);
  if (last === undefined || text.length - last > PROMPT_TAIL_CHARS) return null;
  // The last frame: from the previous prompt draw (or a bounded window) to the end.
  const previous = prompts.length > 1 ? prompts.at(-2)! : Math.max(0, last - FRAME_CHARS);
  const frame = text.slice(Math.max(previous + 1, last - FRAME_CHARS));
  const busy = [...BUSY_PATTERNS, ...BACKGROUND_PATTERNS].some((p) => p.test(frame));
  return busy ? 'running' : 'idle';
}

/**
 * A working line in the last part of the tail. Only meaningful with output in the last few
 * seconds: a busy CLI redraws its timer constantly, while an idle one leaves old frames behind.
 */
export function workingInTail(logTail: string): boolean {
  const end = stripTerminal(logTail).slice(-1500);
  return WORKING_LINE.test(end) || BUSY_PATTERNS.some((p) => p.test(end));
}

/** True when the tail ends at an input prompt with nothing running (kept for callers). */
export function isAwaitingInput(logTail: string): boolean {
  return tailState(logTail) === 'idle';
}
