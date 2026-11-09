import { afterEach, expect, it, vi } from 'vitest';
import { openDb } from './db.js';
import { getSetting, insertCard, insertProject, setSetting, updateCard } from './store.js';
import { CARD_LINK_OUTBOX, cardLinkingKey, type CardLinkEvent } from '../shared/cardLinking.js';
import { CardLinkWriteBack } from './cardLinking.js';
import { originUrl } from './analysis/git.js';
import { resolveGhIdentity } from './ghAccount.js';
import { run } from './analysis/exec.js';
vi.mock('./analysis/git.js', () => ({ originUrl: vi.fn() }));
vi.mock('./ghAccount.js', () => ({
  resolveGhIdentity: vi.fn(),
  ghAccountSettingKey: (id: number) => `gh-account:${id}`,
}));
vi.mock('./analysis/exec.js', () => ({ run: vi.fn() }));
const databases: ReturnType<typeof openDb>[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
});
function setup() {
  const db = openDb(':memory:');
  databases.push(db);
  const project = insertProject(db, 'Repo', '/repo');
  const card = insertCard(db, project, {
    title: 'Task',
    description: '',
    status: 'todo',
    issueUrl: 'https://github.com/owner/repo/pull/7',
  });
  const instance = {
    enabled: true,
    strategy: 'autonomous',
    gitAutonomy: true,
    projectIds: [project],
  };
  setSetting(db, 'master-orchestrators', { instances: [instance] });
  vi.mocked(originUrl).mockResolvedValue('git@github.com:owner/repo.git');
  vi.mocked(resolveGhIdentity).mockResolvedValue({
    account: {
      owner: 'owner',
      login: 'owner',
      source: 'owner',
      override: null,
      accounts: ['owner'],
    },
    env: undefined,
  });
  vi.mocked(run)
    .mockReset()
    .mockImplementation(async (_command, args) => ({
      stdout: args.includes('user') ? 'owner\n' : '{}',
      stderr: '',
    }));
  const service = new CardLinkWriteBack(db);
  const enable = () => setSetting(db, cardLinkingKey(project), { writeBack: true });
  const move = (status: 'review' | 'done') => updateCard(db, card.id, { status });
  const comments = () => vi.mocked(run).mock.calls.filter(([, args]) => args.includes('POST'));
  return { db, project, card, instance, service, enable, move, comments };
}
it('does nothing by default, then comments on Review and Done without duplicate updates', async () => {
  const t = setup();
  t.move('review');
  await t.service.tick();
  expect(t.comments()).toHaveLength(0);
  t.enable();
  updateCard(t.db, t.card.id, { status: 'todo' });
  t.move('review');
  await t.service.tick();
  expect(t.comments()).toHaveLength(1);
  expect(t.comments()[0]?.[1]).toContain('repos/owner/repo/issues/7/comments');
  expect(t.comments()[0]?.[1]).toContain(`body=${t.card.key} moved to Review.`);
  updateCard(t.db, t.card.id, { title: 'Edited' });
  await t.service.tick();
  expect(t.comments()).toHaveLength(1);
  t.move('done');
  await t.service.tick();
  expect(t.comments()).toHaveLength(1);
  const future = Date.now() + 61_000;
  vi.spyOn(Date, 'now').mockReturnValue(future);
  await t.service.tick();
  expect(t.comments()).toHaveLength(2);
});
it.each([
  'disabled',
  'observe',
  'scope',
  'paused',
  'different-repo',
  'fake-origin',
  'account',
  'effective-token',
])('does not comment when blocked by %s', async (mode) => {
  const t = setup();
  t.enable();
  t.move('review');
  if (mode === 'disabled') t.instance.gitAutonomy = false;
  if (mode === 'observe') t.instance.strategy = 'observe';
  if (mode === 'scope') t.instance.projectIds = [999];
  if (mode === 'paused') t.instance.enabled = false;
  setSetting(t.db, 'master-orchestrators', { instances: [t.instance] });
  if (mode === 'different-repo')
    vi.mocked(originUrl).mockResolvedValue('https://github.com/foreign/repo');
  if (mode === 'fake-origin')
    vi.mocked(originUrl).mockResolvedValue('https://evil.test/https://github.com/owner/repo');
  if (mode === 'account')
    vi.mocked(resolveGhIdentity).mockResolvedValue({
      account: {
        owner: 'owner',
        login: 'foreign',
        source: 'active',
        accounts: [],
        override: null,
      },
      env: undefined,
    });
  if (mode === 'effective-token')
    vi.mocked(run).mockResolvedValue({ stdout: 'foreign', stderr: '' });
  await t.service.tick();
  expect(t.comments()).toHaveLength(0);
});
it('rechecks authorization after async identity reads and discards obsolete transitions', async () => {
  const t = setup();
  t.enable();
  t.move('review');
  vi.mocked(run).mockImplementationOnce(async () => {
    setSetting(t.db, cardLinkingKey(t.project), { writeBack: false });
    return { stdout: 'owner', stderr: '' };
  });
  await t.service.tick();
  expect(t.comments()).toHaveLength(0);
  t.enable();
  t.move('done');
  updateCard(t.db, t.card.id, { status: 'todo' });
  await t.service.tick();
  expect(t.comments()).toHaveLength(0);
});
it('persists before uncertain delivery and will not replay after restart or repeated moves', async () => {
  const t = setup();
  t.enable();
  t.move('review');
  vi.mocked(run).mockImplementation(async (_command, args) => {
    if (args.includes('POST')) throw Error('lost response');
    return { stdout: 'owner', stderr: '' };
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await t.service.tick();
  updateCard(t.db, t.card.id, { status: 'todo' });
  t.move('review');
  await new CardLinkWriteBack(t.db).tick();
  expect(t.comments()).toHaveLength(1);
  expect(getSetting<CardLinkEvent[]>(t.db, CARD_LINK_OUTBOX)).toEqual([]);
});
it('rate limits a burst to ten per hour and coalesces rapid Review to Done', async () => {
  const t = setup();
  t.enable();
  t.move('review');
  t.move('done');
  expect(getSetting<CardLinkEvent[]>(t.db, CARD_LINK_OUTBOX)).toHaveLength(1);
  setSetting(t.db, `card-link-rate:${t.project}`, {
    attempts: Array(10).fill(Date.now() - 61_000),
  });
  await t.service.tick();
  expect(t.comments()).toHaveLength(0);
});

it('does not starve another project behind twenty throttled events', async () => {
  const t = setup();
  t.enable();
  t.move('review');
  const first = getSetting<CardLinkEvent[]>(t.db, CARD_LINK_OUTBOX)![0]!;
  const pending = Array.from({ length: 20 }, (_, index) => {
    const card = insertCard(t.db, t.project, {
      title: String(index),
      description: '',
      status: 'review',
      issueUrl: first.url,
    });
    return { ...first, id: `pending-${index}`, cardId: card.id };
  });
  const other = insertProject(t.db, 'Other', '/other');
  setSetting(t.db, cardLinkingKey(other), { writeBack: true });
  setSetting(t.db, 'master-orchestrators', { instances: [{ ...t.instance, projectIds: [] }] });
  const card = insertCard(t.db, other, {
    title: 'Other',
    description: '',
    status: 'review',
    issueUrl: first.url,
  });
  setSetting(t.db, CARD_LINK_OUTBOX, [
    ...pending,
    { ...first, id: 'other', projectId: other, cardId: card.id },
  ]);
  setSetting(t.db, `card-link-rate:${t.project}`, { attempts: Array(10).fill(Date.now() - 61000) });
  await t.service.tick();
  expect(t.comments()).toHaveLength(0);
  await t.service.tick();
  expect(t.comments()).toHaveLength(1);
});
