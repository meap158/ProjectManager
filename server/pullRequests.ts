import { z } from 'zod';
import { run } from './analysis/exec.js';
import type { PullRequestsResult } from '../shared/types.js';

const rows = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.string().url(),
    author: z.object({ login: z.string() }).nullable(),
    isDraft: z.boolean(),
    headRefName: z.string(),
    baseRefName: z.string(),
    updatedAt: z.string(),
    reviewDecision: z.string().nullable(),
  }),
);

export async function pullRequests(cwd: string): Promise<PullRequestsResult> {
  try {
    const { stdout } = await run(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'number,title,url,author,isDraft,headRefName,baseRefName,updatedAt,reviewDecision',
      ],
      { cwd, timeoutMs: 15_000 },
    );
    const requests = rows.parse(JSON.parse(stdout)).filter((p) => {
      const url = new URL(p.url);
      return url.protocol === 'https:';
    });
    return { requests, error: null, fetchedAt: new Date().toISOString() };
  } catch (error) {
    const e = error as Error & { code?: string; stderr?: string };
    return {
      requests: [],
      error:
        e.code === 'ENOENT'
          ? 'Install GitHub CLI (gh) and run gh auth login to view pull requests.'
          : e.stderr?.trim().slice(0, 1000) ||
            'Could not load pull requests. Check gh auth status and the project GitHub remote.',
      fetchedAt: new Date().toISOString(),
    };
  }
}
