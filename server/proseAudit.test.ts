import { describe, expect, it } from 'vitest';
import { addedLines, scanText, tellsInLine } from '../scripts/prose-audit.mjs';

// Prose audit (PM-314): the writing rule is enforced by pattern for the tells a pattern can catch,
// on prose only, and on added lines for new work so old text never blocks a project.

describe('tellsInLine', () => {
  it('finds an em dash, a stock word and chatbot residue', () => {
    expect(tellsInLine('The tool is fast — and simple')).toEqual(['em-dash']);
    expect(tellsInLine('We delve into the data')).toEqual(['stock-word']);
    expect(tellsInLine('Great question! Here it is')).toEqual(['chatbot-residue']);
    expect(tellsInLine('It is not just a tool, it is a shift')).toContain('not-x-but-y');
  });

  it('leaves plain text, hyphens and ranges alone', () => {
    expect(tellsInLine('Plain text with a well-known 10-20 range')).toEqual([]);
  });
});

describe('scanText', () => {
  it('skips fenced code and reports line numbers', () => {
    const text = ['intro', '```', 'a — b', '```', 'then — this'].join('\n');
    expect(scanText(text)).toEqual([{ line: 5, id: 'em-dash', text: 'then — this' }]);
  });
});

describe('addedLines', () => {
  it('keeps only added lines and numbers them from the hunk header', () => {
    const diff = [
      '+++ b/README.md',
      '@@ -3,2 +3,3 @@',
      ' context',
      '-old',
      '+new — line',
      ' tail',
    ].join('\n');
    expect(addedLines(diff)).toEqual([{ file: 'README.md', line: 4, text: 'new — line' }]);
  });
});
