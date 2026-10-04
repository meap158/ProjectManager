import type { LanguageDef } from './languages.js';

export interface LineCounts {
  lines: number;
  code: number;
  comments: number;
  blanks: number;
  complexity: number;
}

/**
 * Classifies each line as code, comment or blank and estimates complexity by counting branching
 * tokens in the code portion. This is a heuristic (like scc/cloc): strings are skipped only within
 * a single line, and nested block comments are not tracked.
 */
export function countLines(content: string, lang: LanguageDef): LineCounts {
  const result: LineCounts = { lines: 0, code: 0, comments: 0, blanks: 0, complexity: 0 };
  if (content.length === 0) return result;

  const branchRe = lang.branches ? new RegExp(lang.branches, 'g') : null;
  const quotes = lang.branches ? ['"', "'", '`'] : ['"'];
  const lines = content.split(/\r\n|\r|\n/);
  // A trailing newline produces a final empty element that isn't a real line.
  if (lines[lines.length - 1] === '') lines.pop();

  let blockEnd: string | null = null;

  for (const line of lines) {
    result.lines++;
    if (line.trim() === '') {
      result.blanks++;
      continue;
    }

    let code = '';
    let hadComment = false;
    let i = 0;

    scan: while (i < line.length) {
      if (blockEnd !== null) {
        hadComment = true;
        const end = line.indexOf(blockEnd, i);
        if (end === -1) break;
        i = end + blockEnd.length;
        blockEnd = null;
        continue;
      }

      const ch = line[i]!;
      if (quotes.includes(ch)) {
        const close = findClosingQuote(line, i + 1, ch);
        code += line.slice(i, close);
        i = close;
        continue;
      }
      for (const token of lang.lineComments) {
        if (line.startsWith(token, i)) {
          hadComment = true;
          break scan;
        }
      }
      for (const [start, end] of lang.blockComments) {
        if (line.startsWith(start, i)) {
          hadComment = true;
          blockEnd = end;
          i += start.length;
          continue scan;
        }
      }
      code += ch;
      i++;
    }

    if (code.trim() !== '') {
      result.code++;
      if (branchRe) result.complexity += code.match(branchRe)?.length ?? 0;
    } else if (hadComment) {
      result.comments++;
    } else {
      result.blanks++;
    }
  }

  return result;
}

/** Returns the index just past the closing quote, or the end of the line if unterminated. */
function findClosingQuote(line: string, from: number, quote: string): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === '\\') {
      i++;
      continue;
    }
    if (line[i] === quote) return i + 1;
  }
  return line.length;
}
