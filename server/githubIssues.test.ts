import { beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from './analysis/exec.js';
import { createApp } from './app.js';
import { openDb, type Db } from './db.js';
import { createCardIssue } from './githubIssues.js';
import { resetGhAccountCache } from './ghAccount.js';
import * as store from './store.js';

vi.mock('./analysis/exec.js', () => ({ run: vi.fn() }));

const HOST = { host: 'localhost:5180' };
const ISSUE_URL = 'https://github.com/meap158/TiemNet/issues/12';
const TOKEN = `gho_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
const STATUS_JSON = JSON.stringify({
  hosts: {
    'github.com': [
      { state: 'success', active: false, host: 'github.com', login: 'meap158' },
      { state: 'success', active: true, host: 'github.com', login: 'meapwork' },
    ],
  },
});

/** gh as seen from a folder whose origin is `remote`; `issue` answers `gh issue create`. */
function fakeGh(
  remote: string,
  issue: { stdout?: string; fail?: boolean } = { stdout: `${ISSUE_URL}\n` },
) {
  vi.mocked(run).mockImplementation(((cmd: string, args: string[]) => {
    if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'status')
      return Promise.resolve({ stdout: STATUS_JSON, stderr: '' });
    if (cmd === 'gh' && args[0] === 'auth' && args[1] === 'token')
      return Promise.resolve({ stdout: `${TOKEN}\n`, stderr: '' });
    if (cmd === 'gh' && args[0] === 'repo')
      return Promise.resolve({
        stdout: 'X No default remote repository has been set.',
        stderr: '',
      });
    if (cmd === 'git' && args[0] === 'config')
      return Promise.resolve({ stdout: `remote.origin.url ${remote}\n`, stderr: '' });
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'create') {
      if (issue.fail) return Promise.reject(Object.assign(new Error('failed'), { stderr: '' }));
      return Promise.resolve({ stdout: issue.stdout ?? '', stderr: '' });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  }) as never);
}

const card = { id: 7, key: 'PM-7', title: 'Dark mode', description: 'Follow the theme.' };

describe('createCardIssue', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetGhAccountCache();
  });

  it('creates the issue with an argument array and returns its URL', async () => {
    fakeGh('https://github.com/meap158/TiemNet.git');
    const created = await createCardIssue('folder', card, null);
    expect(created).toEqual({ url: ISSUE_URL });
    const create = vi
      .mocked(run)
      .mock.calls.find(([cmd, args]) => cmd === 'gh' && args[0] === 'issue');
    expect(create?.[1]).toEqual([
      'issue',
      'create',
      '--title',
      '[PM-7] Dark mode',
      '--body',
      'Follow the theme.\n\n---\nFiled from the ProjectManager board (PM-7).',
    ]);
    // Acts as the repo owner, through that call's GH_TOKEN only.
    const withEnv = vi.mocked(run).mock.calls.find(([, , options]) => options?.env?.GH_TOKEN);
    expect(withEnv?.[2]?.env?.GH_TOKEN).toBe(TOKEN);
  });

  it('refuses when gh prints no issue URL', async () => {
    fakeGh('https://github.com/meap158/TiemNet.git', { stdout: 'created, see the log\n' });
    await expect(createCardIssue('folder', card, null)).rejects.toMatchObject({ status: 502 });
  });

  it('fails closed when gh itself fails', async () => {
    fakeGh('https://github.com/meap158/TiemNet.git', { fail: true });
    await expect(createCardIssue('folder', card, null)).rejects.toMatchObject({ status: 502 });
  });

  it('refuses to act as an account that is not logged in', async () => {
    fakeGh('https://github.com/meap158/TiemNet.git');
    await expect(createCardIssue('folder', card, 'someone-else')).rejects.toMatchObject({
      status: 409,
    });
    expect(
      vi.mocked(run).mock.calls.some(([cmd, args]) => cmd === 'gh' && args[0] === 'issue'),
    ).toBe(false);
  });
});

describe('POST /cards/:id/github-issue', () => {
  let db: Db;
  let call: (
    method: string,
    url: string,
    body?: unknown,
  ) => Promise<{ status: number; json: () => Promise<never> }>;

  beforeEach(() => {
    vi.resetAllMocks();
    resetGhAccountCache();
    db = openDb(':memory:');
    const app = createApp(db);
    call = (method: string, url: string, body?: unknown) =>
      app.request(`/api${url}`, {
        method,
        headers: { ...HOST, 'content-type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }) as never;
  });

  const seed = () => {
    const projectId = store.insertProject(db, 'TiemNet', 'folder');
    const created = store.insertCard(db, projectId, {
      title: 'Dark mode',
      description: 'Follow the theme.',
      status: 'todo',
    });
    return { projectId, cardId: created.id };
  };

  it('links the created issue back onto the card', async () => {
    fakeGh('https://github.com/meap158/TiemNet.git');
    const { cardId } = seed();
    const res = await call('POST', `/cards/${cardId}/github-issue`, {});
    expect(res.status).toBe(201);
    expect(store.getCard(db, cardId)?.issueUrl).toBe(ISSUE_URL);
  });

  it('refuses cards that already link an issue or belong to no project', async () => {
    fakeGh('https://github.com/meap158/TiemNet.git');
    const { cardId } = seed();
    store.updateCard(db, cardId, { issueUrl: ISSUE_URL });
    expect((await call('POST', `/cards/${cardId}/github-issue`, {})).status).toBe(409);
    const loose = store.insertCard(db, 0, { title: 'Loose', description: '', status: 'todo' });
    expect((await call('POST', `/cards/${loose.id}/github-issue`, {})).status).toBe(400);
    expect((await call('POST', '/cards/99999/github-issue', {})).status).toBe(404);
    expect(vi.mocked(run).mock.calls.some(([cmd]) => cmd === 'gh')).toBe(false);
  });
});
