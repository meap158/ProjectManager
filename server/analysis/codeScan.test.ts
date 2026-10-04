import { describe, expect, it } from 'vitest';
import { aggregate, mapLimit, type FileResult } from './codeScan.js';
import { parseSccOutput } from './scc.js';

const file = (path: string, language: string | null, code: number, bytes = 100): FileResult => ({
  path,
  bytes,
  language,
  lines: code,
  code,
  comments: 1,
  blanks: 1,
  complexity: 2,
});

describe('aggregate', () => {
  it('groups by language, counts nested folders and ranks largest files', () => {
    const stats = aggregate(
      [
        file('src/a.ts', 'TypeScript', 10, 500),
        file('src/deep/b.ts', 'TypeScript', 5),
        file('docs/x.png', null, 0, 9000),
        file('main.py', 'Python', 20),
      ],
      false,
    );
    expect(stats.languages.map((l) => [l.name, l.files, l.code])).toEqual([
      ['Python', 1, 20],
      ['TypeScript', 2, 15],
    ]);
    expect(stats).toMatchObject({
      totalFiles: 4,
      countedFiles: 3,
      code: 35,
      folders: 3,
      bytes: 9700,
    });
    expect(stats.largestFiles[0]!.path).toBe('docs/x.png');
  });
});

describe('mapLimit', () => {
  it('preserves order and respects the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });
});

describe('parseSccOutput', () => {
  it('maps scc JSON into language stats and per-file lines', () => {
    const json = JSON.stringify([
      {
        Name: 'Go',
        Bytes: 300,
        Code: 20,
        Comment: 2,
        Blank: 3,
        Complexity: 4,
        Count: 2,
        Files: [{ Location: '.\\cmd\\main.go', Lines: 25 }],
      },
      {
        Name: 'YAML',
        Bytes: 50,
        Code: 30,
        Comment: 0,
        Blank: 0,
        Complexity: 0,
        Count: 1,
        Files: null,
      },
    ]);
    const result = parseSccOutput(json);
    expect(result.languages.map((l) => l.name)).toEqual(['YAML', 'Go']);
    expect(result.files).toEqual([{ path: 'cmd/main.go', lines: 25 }]);
  });
});
