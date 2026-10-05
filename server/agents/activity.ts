// Decides whether an agent CLI is waiting for input by reading its log tail.
//
// Why this exists: "working" used to mean "the log file changed recently", but TUI
// status redraws (elapsed timers, spinners) keep the file fresh for hours while the
// agent sits at its input prompt. An input prompt *after* the last busy signal means
// the agent is waiting, no matter what a stale status line above it claims.

/** Matches the vendor's own input prompts (tested against real terminal dumps). */
const IDLE_PATTERNS = [
  // Codex: "Ask Codex to do anything" above its input line.
  /ask\s+\S+\s+to\s+do\s+anything\s*$/im,
  // Claude Code / Gemini: a bare ❯ prompt as the last thing on a line.
  // (Matched at the very end only — ❯ also appears quoted inside real output.)
  /❯[ \t]*$/,
];

/** Matches busy chrome that supersedes an older prompt further up. */
const BUSY_PATTERNS = [/esc to interrupt/i, /working\s*\(\s*\d+[mh]/i];

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

/**
 * True when the tail ends at an input prompt newer than any busy signal.
 * Unknown CLIs (shell, custom, anything unmatched) return false so callers fall
 * back to output recency — never worse than before.
 */
export function isAwaitingInput(logTail: string): boolean {
  const text = stripTerminal(logTail);
  const lastIndexOf = (p: RegExp): number => {
    const flags = p.flags.includes('g') ? p.flags : `${p.flags}g`;
    const re = new RegExp(p.source, flags);
    let last = -1;
    for (let match = re.exec(text); match; match = re.exec(text)) last = match.index;
    return last;
  };
  const lastBusy = Math.max(-1, ...BUSY_PATTERNS.map(lastIndexOf));
  const lastIdle = Math.max(-1, ...IDLE_PATTERNS.map(lastIndexOf));
  if (lastIdle < 0) return false;
  if (lastBusy > lastIdle) return false;
  // The prompt must be near the end: scrollback prompts don't mean idle now.
  return text.length - lastIdle <= PROMPT_TAIL_CHARS;
}
