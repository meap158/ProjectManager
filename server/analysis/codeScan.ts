import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CodeStats, FileSize, LanguageStats } from '../../shared/types.js';
import { listSourceFiles } from './fileList.js';
import { detectLanguage } from './languages.js';
import { countLines } from './lineCounter.js';
import { runScc } from './scc.js';

/** Files larger than this are counted for size but not parsed for lines. */
const MAX_PARSE_BYTES = 2 * 1024 * 1024;
const CONCURRENCY = 32;
const LARGEST_FILES = 10;

export interface FileResult {
  path: string;
  bytes: number;
  language: string | null;
  lines: number;
  code: number;
  comments: number;
  blanks: number;
  complexity: number;
}

/** Scans a project's source files. Uses scc for line counts when it is installed. */
export async function scanCode(root: string): Promise<CodeStats> {
  const list = await listSourceFiles(root);
  const results = await mapLimit(list.files, CONCURRENCY, (rel) => analyzeFile(root, rel));
  const files = results.filter((r): r is FileResult => r !== null);
  const stats = aggregate(files, list.truncated);

  const scc = await runScc(root);
  if (scc) {
    const linesByPath = new Map(scc.files.map((f) => [f.path, f.lines]));
    return {
      ...stats,
      engine: 'scc',
      countedFiles: scc.languages.reduce((sum, l) => sum + l.files, 0),
      code: sum(scc.languages, 'code'),
      comments: sum(scc.languages, 'comments'),
      blanks: sum(scc.languages, 'blanks'),
      complexity: sum(scc.languages, 'complexity'),
      languages: scc.languages,
      largestFiles: stats.largestFiles.map((f) => ({
        ...f,
        lines: linesByPath.get(f.path) ?? f.lines,
      })),
    };
  }
  return stats;
}

async function analyzeFile(root: string, rel: string): Promise<FileResult | null> {
  const abs = path.join(root, rel);
  let size: number;
  try {
    const info = await stat(abs);
    if (!info.isFile()) return null;
    size = info.size;
  } catch {
    return null; // Deleted since listing, broken symlink, permission denied...
  }

  const base: FileResult = {
    path: rel.replaceAll('\\', '/'),
    bytes: size,
    language: null,
    lines: 0,
    code: 0,
    comments: 0,
    blanks: 0,
    complexity: 0,
  };
  const lang = detectLanguage(path.basename(rel));
  if (!lang || size > MAX_PARSE_BYTES) return base;

  let buffer: Buffer;
  try {
    const handle = await open(abs, 'r');
    try {
      buffer = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return base;
  }
  if (buffer.subarray(0, 8000).includes(0)) return base; // Binary despite the extension.

  return { ...base, language: lang.name, ...countLines(buffer.toString('utf8'), lang) };
}

export function aggregate(files: FileResult[], truncated: boolean): CodeStats {
  const languages = new Map<string, LanguageStats>();
  const folders = new Set<string>();
  let bytes = 0;

  for (const file of files) {
    bytes += file.bytes;
    const slash = file.path.lastIndexOf('/');
    if (slash > 0) {
      // Count every ancestor folder so nested folders without direct files still count.
      const parts = file.path.slice(0, slash).split('/');
      for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    }
    if (!file.language) continue;
    const lang = languages.get(file.language) ?? {
      name: file.language,
      files: 0,
      bytes: 0,
      code: 0,
      comments: 0,
      blanks: 0,
      complexity: 0,
    };
    lang.files++;
    lang.bytes += file.bytes;
    lang.code += file.code;
    lang.comments += file.comments;
    lang.blanks += file.blanks;
    lang.complexity += file.complexity;
    languages.set(file.language, lang);
  }

  const languageList = [...languages.values()].sort((a, b) => b.code - a.code);
  const largestFiles: FileSize[] = [...files]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, LARGEST_FILES)
    .map((f) => ({ path: f.path, bytes: f.bytes, lines: f.lines }));

  return {
    engine: 'builtin',
    totalFiles: files.length,
    countedFiles: languageList.reduce((n, l) => n + l.files, 0),
    code: sum(languageList, 'code'),
    comments: sum(languageList, 'comments'),
    blanks: sum(languageList, 'blanks'),
    complexity: sum(languageList, 'complexity'),
    languages: languageList,
    bytes,
    folders: folders.size,
    largestFiles,
    truncated,
  };
}

function sum<K extends string>(items: Record<K, number>[], key: K): number {
  return items.reduce((n, item) => n + item[key], 0);
}

/** Maps over items with at most `limit` promises in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
