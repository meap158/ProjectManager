import { describe, expect, it } from 'vitest';
import { detectLanguage } from './languages.js';
import { countLines } from './lineCounter.js';

const ts = detectLanguage('file.ts')!;
const py = detectLanguage('file.py')!;

describe('countLines', () => {
  it('classifies code, comments and blanks', () => {
    const src = [
      '// header',
      'const a = 1;',
      '',
      '/* block',
      '   still comment */',
      'call(); // trailing',
      '',
    ].join('\n');
    expect(countLines(src, ts)).toMatchObject({ lines: 6, code: 2, comments: 3, blanks: 1 });
  });

  it('does not treat comment markers inside strings as comments', () => {
    const src = [
      "const glob = 'src/**/*.ts';",
      'const url = "http://example.com";',
      'next();',
    ].join('\n');
    expect(countLines(src, ts)).toMatchObject({ code: 3, comments: 0 });
  });

  it('counts code after a block comment closes on the same line', () => {
    expect(countLines('/* a */ run();', ts)).toMatchObject({ code: 1, comments: 0 });
  });

  it('estimates complexity from branching tokens', () => {
    const src = [
      'if (a && b) {',
      '  for (const x of y) {}',
      '} else if (c || d) {}',
      'const t = ok ? 1 : 2;',
      'let n: number | undefined = x?.y ?? z;',
    ].join('\n');
    // if, &&, for, if, ||, ternary ?, ?? = 7 (optional chaining is not a branch)
    expect(countLines(src, ts).complexity).toBe(7);
  });

  it('handles hash-comment languages', () => {
    const src = ['# comment', 'if x and y:', '    pass', ''].join('\n');
    expect(countLines(src, py)).toMatchObject({ code: 2, comments: 1, complexity: 2 });
  });

  it('handles CRLF line endings and empty files', () => {
    expect(countLines('a();\r\n\r\nb();\r\n', ts)).toMatchObject({ lines: 3, code: 2, blanks: 1 });
    expect(countLines('', ts).lines).toBe(0);
  });
});

describe('detectLanguage', () => {
  it('detects by extension and exact filename, skipping generated files', () => {
    expect(detectLanguage('App.TSX')?.name).toBe('TSX');
    expect(detectLanguage('Dockerfile')?.name).toBe('Dockerfile');
    expect(detectLanguage('package-lock.json')).toBeUndefined();
    expect(detectLanguage('vendor.min.js')).toBeUndefined();
    expect(detectLanguage('README')).toBeUndefined();
  });
});
