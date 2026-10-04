// Optional integration with scc (https://github.com/boyter/scc), a fast, widely used line counter.
// When `scc` is on PATH it replaces the built-in counter for line/complexity numbers. Disable with
// SCC=off.

import type { LanguageStats } from '../../shared/types.js';
import { isAvailable, run } from './exec.js';

interface SccFile {
  Location: string;
  Lines: number;
}

interface SccLanguage {
  Name: string;
  Bytes: number;
  Code: number;
  Comment: number;
  Blank: number;
  Complexity: number;
  Count: number;
  Files?: SccFile[] | null;
}

export interface SccResult {
  languages: LanguageStats[];
  files: { path: string; lines: number }[];
}

export async function runScc(root: string): Promise<SccResult | null> {
  if (process.env.SCC === 'off' || !(await isAvailable('scc'))) return null;
  try {
    const { stdout } = await run('scc', ['--format', 'json', '--by-file', '--no-cocomo', '.'], {
      cwd: root,
    });
    return parseSccOutput(stdout);
  } catch (error) {
    console.warn(`[scan] scc failed, using built-in counter: ${(error as Error).message}`);
    return null;
  }
}

export function parseSccOutput(json: string): SccResult {
  const raw = JSON.parse(json) as SccLanguage[];
  const languages = raw
    .map((l) => ({
      name: l.Name,
      files: l.Count,
      bytes: l.Bytes,
      code: l.Code,
      comments: l.Comment,
      blanks: l.Blank,
      complexity: l.Complexity,
    }))
    .sort((a, b) => b.code - a.code);
  const files = raw.flatMap((l) =>
    (l.Files ?? []).map((f) => ({
      path: f.Location.replaceAll('\\', '/').replace(/^\.\//, ''),
      lines: f.Lines,
    })),
  );
  return { languages, files };
}
