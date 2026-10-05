// Decides what an agent CLI is doing by reading its log tail.
//
// Why this exists: "running" used to mean "the log file changed recently", but TUI status
// redraws (elapsed timers, spinners) keep the file fresh for hours while the agent waits.
// Conversely, Codex and Claude Code draw their input box on every frame, even mid-task, so
// "a prompt is on screen" doesn't mean idle either. What counts is the *last frame* (the text
// between the last two prompt draws): busy chrome or a still-running background job there
// means running (owner rule PM-14: a shell or subtask the session started keeps it running);
// a prompt with neither means the agent is waiting for you.

export type TailState = 'running' | 'idle';

/** The vendors' own input prompts (tested against real terminal dumps). */
const PROMPT_PATTERNS = [
  // Codex: "Ask Codex to do anything" placeholder in its input line.
  /ask\s+\S+\s+to\s+do\s+anything/gi,
  // Claude Code / Gemini: a bare ❯ prompt as the last thing on a line.
  /❯[ \t]*$/gm,
];

/** The CLI is working on a turn right now. */
const BUSY_PATTERNS = [/esc to interrupt/i, /working\s*\(\s*\d+[smh]/i];

/** Something the session started is still going (background shells, terminals, subagents). */
const BACKGROUND_PATTERNS = [
  /\b\d+\s+background\s+(?:terminals?|shells?|agents?|tasks?)\s+running/i,
  /waiting for \d+ background/i,
  /\b\d+\s+shells?\s+still\s+running/i,
  // Claude Code's footer: "auto mode on · 1 shell · ← 1 agent · ↓ to manage".
  /·\s*\d+\s+shells?\s*·/,
  /←\s*\d+\s+agents?\b/,
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
  const prompts = promptOffsets(text);
  const last = prompts.at(-1);
  if (last === undefined || text.length - last > PROMPT_TAIL_CHARS) return null;
  // The last frame: from the previous prompt draw (or a bounded window) to the end.
  const previous = prompts.length > 1 ? prompts.at(-2)! : Math.max(0, last - FRAME_CHARS);
  const frame = text.slice(Math.max(previous + 1, last - FRAME_CHARS));
  const busy = [...BUSY_PATTERNS, ...BACKGROUND_PATTERNS].some((p) => p.test(frame));
  return busy ? 'running' : 'idle';
}

/** True when the tail ends at an input prompt with nothing running (kept for callers). */
export function isAwaitingInput(logTail: string): boolean {
  return tailState(logTail) === 'idle';
}
