/* eslint-disable no-control-regex -- Parsing recorded ANSI control sequences is intentional. */
import { stripVTControlCharacters } from 'node:util';

/** ConPTY full-screen redraws start at home and paint complete rows ending in EL.
 * The first blank row records the actual width, unlike cursor maxima across old sizes.
 * Replay the latest complete redraw rather than overlaying incompatible older screens.
 */
export function legacyTerminalSnapshot(data: string): string | null {
  if (data.includes('\x1b]777;pm-size;')) return null;
  const redraw = /\x1b\[H((?:(?:[^\x1b]|\x1b\[[0-9;]*m)*\x1b\[K){10,})/g;
  let latest: { offset: number; cols: number } | null = null;
  for (const match of data.matchAll(redraw)) {
    const first = stripVTControlCharacters(match[1]!.split('\x1b[K')[0]!);
    if (first.length >= 20 && first.length <= 500 && !/[\r\n]/.test(first)) {
      latest = { offset: match.index, cols: first.length };
    }
  }
  if (!latest) return null;
  const tail = data.slice(latest.offset);
  const rows = inferTerminalGeometry(tail).rows;
  return `\x1bc\x1b]777;pm-size;${latest.cols};${rows}\x07${tail}`;
}

/** Conservative canvas bounds for legacy full-screen logs without resize records. */
export function inferTerminalGeometry(data: string): { cols: number; rows: number } {
  let cols = 120;
  let rows = 30;
  const cursor = /\x1b\[(\d+);(\d+)[Hf]/g;
  let previous: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = cursor.exec(data))) {
    if (previous) {
      // Text following a cursor position can extend past that column. Stop at the next
      // cursor/control operation; colours alone don't move the cursor.
      const segment = data.slice(previous.index + previous[0].length, match.index);
      const text = stripVTControlCharacters(segment.split(/\x1b\[(?![\d;]*m)/)[0]!).split(
        /[\r\n]/,
      )[0]!;
      cols = Math.max(cols, Number(previous[2]) - 1 + [...text].length);
    }
    rows = Math.max(rows, Number(match[1]));
    cols = Math.max(cols, Number(match[2]));
    previous = match;
  }
  if (previous) {
    const text = stripVTControlCharacters(
      data.slice(previous.index + previous[0].length).split(/\x1b\[(?![\d;]*m)/)[0]!,
    ).split(/[\r\n]/)[0]!;
    cols = Math.max(cols, Number(previous[2]) - 1 + [...text].length);
  }
  return { cols: Math.min(500, cols), rows: Math.min(500, rows) };
}
