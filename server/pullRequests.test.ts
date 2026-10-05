import { beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from './analysis/exec.js';
import { pullRequests } from './pullRequests.js';
vi.mock('./analysis/exec.js', () => ({ run: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
describe('pull requests', () => {
  it('uses the project cwd and returns draft/review metadata', async () => {
    vi.mocked(run).mockResolvedValue({
      stderr: '',
      stdout: JSON.stringify([
        {
          number: 3,
          title: 'Fix',
          url: 'https://github.com/a/b/pull/3',
          author: { login: 'dev' },
          isDraft: true,
          headRefName: 'fix',
          baseRefName: 'main',
          updatedAt: '2026-10-06',
          reviewDecision: 'APPROVED',
        },
      ]),
    });
    const result = await pullRequests('project folder');
    expect(result.requests[0]?.isDraft).toBe(true);
    expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining(['--state', 'open']), {
      cwd: 'project folder',
      timeoutMs: 15_000,
    });
  });
  it('reports missing gh and authentication failures without crashing the project page', async () => {
    vi.mocked(run).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    expect((await pullRequests('folder')).error).toContain('gh auth login');
    vi.mocked(run).mockRejectedValue(
      Object.assign(new Error('auth'), { stderr: 'Authentication required' }),
    );
    expect((await pullRequests('folder')).error).toBe('Authentication required');
  });
});
