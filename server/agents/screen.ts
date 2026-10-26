/* eslint-disable no-control-regex -- Parsing recorded terminal control sequences is intentional. */
// What a terminal shows, from the raw output a session logged (PM-129). Stripping escapes
// alone runs a CLI's in-place redraws together: Claude Code repaints its spinner word at a
// fixed cursor position every frame, so the stripped text read "Roosting… Roosting…". This
// replays the output on a grid instead, honouring the cursor moves and erases CLIs use, so
// each cell holds what was drawn there last. Colours and other attributes are dropped.

// `<` too: Claude Code sends the kitty keyboard protocol's "ESC [ < u" (pop flags).
const CSI = /\x1b\[([?<>=!]?)([0-9;:]*)([ -/]*)([@-~])/y;
/** Up to the end of an OSC/DCS string, scanning only as far as its terminator. */
const STRING_END = /[^\x07\x1b]*(?:\x1b(?!\\)[^\x07\x1b]*)*(?:\x07|\x1b\\)/y;
/** Combining marks and zero-width joiners/selectors, which join the previous cell. */
const JOINS = /^(?:\p{M}|[\u200b-\u200f]|\p{Variation_Selector})$/u;

/** Characters that take two cells (CJK, full-width forms, most emoji), as terminals draw them. */
function wide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/**
 * Replays terminal output on a `cols` × `rows` screen and returns its lines (trailing spaces
 * trimmed). Output that scrolls off the top is dropped, as on a real screen, unless `scrollback`
 * keeps up to that many of those lines above the screen, like a terminal's history: a prompt
 * taller than a small terminal (a menu with wrapped descriptions on a phone-sized one) has its
 * question and first options up there. A full clear ("ESC [2J" / "[3J", which Claude Code sends
 * before drawing a frame taller than the terminal) empties it, so only the latest frame's overflow
 * is kept.
 */
export function renderScreen(
  data: string,
  cols: number,
  rows: number,
  sliced = false,
  scrollback = 0,
): string[] {
  const blank = () => Array<string>(cols).fill(' ');
  const grid = Array.from({ length: rows }, blank);
  const history: string[][] = [];
  let row = 0;
  let col = 0;
  let saved = { row: 0, col: 0 };
  // After the last column is written the cursor stays there; only the next character wraps.
  let wrapNext = false;
  const clamp = () => {
    row = Math.max(0, Math.min(rows - 1, row));
    col = Math.max(0, Math.min(cols - 1, col));
  };
  const lineFeed = () => {
    if (row < rows - 1) row++;
    else {
      const gone = grid.shift()!;
      if (scrollback > 0) {
        history.push(gone);
        if (history.length > scrollback) history.shift();
      }
      grid.push(blank());
    }
  };
  // A sliced log can start inside a character or an escape: begin at the first escape.
  const start = sliced ? data.indexOf('\x1b') : 0;
  let i = start > 0 ? start : 0;
  while (i < data.length) {
    const ch = data[i]!;
    if (ch === '\r' || ch === '\n' || ch === '\b' || ch === '\t') wrapNext = false;
    if (ch === '\x1b') {
      const next = data[i + 1];
      if (next === '[') {
        CSI.lastIndex = i;
        const m = CSI.exec(data);
        if (!m) {
          i += 2;
          continue;
        }
        i += m[0].length;
        if (m[1] || m[3]) continue; // Private modes (cursor visibility, alternate screen…).
        if (m[4] !== 'm') wrapNext = false;
        const params = m[2]!.split(/[;:]/).map((p) => (p === '' ? NaN : Number(p)));
        const n = (k: number, fallback = 1) =>
          Number.isFinite(params[k]) && params[k]! > 0 ? params[k]! : fallback;
        switch (m[4]) {
          case 'H':
          case 'f':
            row = n(0) - 1;
            col = n(1) - 1;
            break;
          case 'A':
            row -= n(0);
            break;
          case 'B':
          case 'e':
            row += n(0);
            break;
          case 'C':
          case 'a':
            col += n(0);
            break;
          case 'D':
            col -= n(0);
            break;
          case 'E':
            row += n(0);
            col = 0;
            break;
          case 'F':
            row -= n(0);
            col = 0;
            break;
          case 'G':
          case '`':
            col = n(0) - 1;
            break;
          case 'd':
            row = n(0) - 1;
            break;
          case 'K': {
            const mode = Number.isFinite(params[0]) ? params[0] : 0;
            const line = grid[row]!;
            const [from, to] = mode === 1 ? [0, col + 1] : mode === 2 ? [0, cols] : [col, cols];
            line.fill(' ', from, to);
            break;
          }
          case 'J': {
            const mode = Number.isFinite(params[0]) ? params[0] : 0;
            if (mode === 2 || mode === 3) {
              grid.forEach((line) => line.fill(' '));
              history.length = 0;
            } else if (mode === 1) {
              for (let r = 0; r < row; r++) grid[r]!.fill(' ');
              grid[row]!.fill(' ', 0, col + 1);
            } else {
              grid[row]!.fill(' ', col);
              for (let r = row + 1; r < rows; r++) grid[r]!.fill(' ');
            }
            break;
          }
          case 'X':
            grid[row]!.fill(' ', col, Math.min(cols, col + n(0)));
            break;
          case 'P': {
            const line = grid[row]!;
            line.splice(col, n(0));
            while (line.length < cols) line.push(' ');
            break;
          }
          case '@': {
            const line = grid[row]!;
            line.splice(col, 0, ...Array<string>(n(0)).fill(' '));
            line.length = cols;
            break;
          }
          case 's':
            saved = { row, col };
            break;
          case 'u':
            ({ row, col } = saved);
            break;
        }
        clamp();
        continue;
      }
      if (next === ']' || next === 'P' || next === '_' || next === '^') {
        // OSC / DCS strings (window title, hyperlinks…) end at BEL or ST.
        STRING_END.lastIndex = i + 2;
        i = STRING_END.exec(data) ? STRING_END.lastIndex : data.length;
        continue;
      }
      if (next === '7') saved = { row, col };
      else if (next === '8') ({ row, col } = saved);
      else if (next === 'M') {
        if (row > 0) row--;
        else {
          grid.pop();
          grid.unshift(blank());
        }
      } else if (next === 'D') lineFeed();
      else if (next === 'E') {
        lineFeed();
        col = 0;
      }
      // Charset selections ("ESC ( B") take one more byte.
      i += next !== undefined && '()*+'.includes(next) ? 3 : 2;
      continue;
    }
    if (ch === '\r') {
      col = 0;
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\v' || ch === '\f') {
      lineFeed();
      i++;
      continue;
    }
    if (ch === '\b') {
      if (col > 0) col--;
      i++;
      continue;
    }
    if (ch === '\t') {
      col = Math.min(cols - 1, (Math.floor(col / 8) + 1) * 8);
      i++;
      continue;
    }
    const code = data.codePointAt(i)!;
    const text = String.fromCodePoint(code);
    i += text.length;
    if (code < 0x20 || code === 0x7f) continue;
    if (JOINS.test(text)) {
      if (col > 0) grid[row]![col - 1] += text;
      continue;
    }
    const width = wide(code) ? 2 : 1;
    if (wrapNext || col + width > cols) {
      col = 0;
      lineFeed();
    }
    wrapNext = false;
    grid[row]![col] = text;
    if (width === 2) grid[row]![col + 1] = '';
    col += width;
    if (col >= cols) {
      col = cols - 1;
      wrapNext = true;
    }
  }
  return [...history, ...grid].map((line) => line.join('').replace(/\s+$/, ''));
}
