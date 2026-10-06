import { z } from 'zod';
import { run } from './analysis/exec.js';
import type { PullRequestsResult } from '../shared/types.js';
import type { RefEvent } from './analysis/cardRefs.js';

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

const refRows = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable().optional(),
    headRefName: z.string(),
    state: z.string(),
    createdAt: z.string(),
    mergedAt: z.string().nullable().optional(),
  }),
);

/**
 * Recent pull requests (open, merged and closed) as board events: an open PR referencing a card
 * (title, description or branch name) and, once merged, the merge. Null when gh is missing, not
 * signed in, or the project has no GitHub remote.
 */
export async function pullRequestEvents(cwd: string): Promise<RefEvent[] | null> {
  try {
    const { stdout } = await run(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'all',
        '--limit',
        '50',
        '--json',
        'number,title,body,headRefName,state,createdAt,mergedAt',
      ],
      { cwd, timeoutMs: 20_000 },
    );
    return refRows.parse(JSON.parse(stdout)).flatMap((pr): RefEvent[] => {
      const text = `${pr.title}\n${pr.body ?? ''}\n${pr.headRefName}`;
      const source = `PR #${pr.number}`;
      const opened: RefEvent = {
        id: `pr:${pr.number}:open`,
        kind: 'pr-open',
        at: pr.createdAt,
        text,
        source,
      };
      if (pr.state === 'MERGED' && pr.mergedAt) {
        const merged: RefEvent = {
          id: `pr:${pr.number}:merged`,
          kind: 'pr-merged',
          at: pr.mergedAt,
          text,
          source,
        };
        return [opened, merged];
      }
      return pr.state === 'OPEN' ? [opened] : []; // Closed unmerged: no move.
    });
  } catch {
    return null;
  }
}
