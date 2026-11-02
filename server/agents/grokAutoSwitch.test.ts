import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { NativeAccount, NativeAccountsState } from '../../shared/nativeAccounts.js';
import type { AgentSession } from '../../shared/types.js';
import { openDb } from '../db.js';
import { insertProject } from '../store.js';
import type { GrokAccounts } from './grokAccounts.js';
import { AgentSupervisor } from './supervisor.js';

// The Grok rotation tick (PM-412): when it switches, which sessions it restarts, and that it
// never acts on the screen message alone. Account storage and restarts are stubbed.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const reading = (id: string, used: number): NativeAccount => {
  const asOf = new Date().toISOString();
  return {
    id,
    name: `Grok ${id}`,
    email: `${id}@example.com`,
    active: false,
    plan: null,
    usage: { fiveHour: null, weekly: used, updatedAt: asOf },
    usageStatus: 'fresh',
    limits: {
      providerId: 'grok',
      source: 'fixture',
      asOf,
      windows: [
        {
          label: 'Weekly',
          windowMinutes: 10_080,
          usedPercent: used,
          resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ],
    },
  };
};

async function setup(currentUsed: number) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pm-grok-rotation-'));
  vi.stubEnv('GROK_HOME', path.join(root, 'grok-home'));
  const db = openDb(':memory:');
  const supervisor = new AgentSupervisor(db, path.join(root, 'logs'), { dataDir: root });
  await supervisor.ready;
  const inside = supervisor as unknown as {
    grokAccounts: GrokAccounts;
    tickGrokRotation(): void;
    live: Map<string, unknown>;
    sessionActivity(row: { id: number }, last: string | null): 'idle' | 'running' | 'input';
    sessionScreen(id: number): string;
  };
  cleanups.push(async () => {
    inside.live.clear();
    await supervisor.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = insertProject(db, 'fixture', root);
  let current = reading('a', currentUsed);
  const saved = [reading('b', 30)];
  const state = (): NativeAccountsState => ({
    available: true,
    accounts: [{ ...current, active: true }, ...saved.filter((s) => s.id !== current.id)],
    defaultAccount: { ...current, active: true },
  });
  const accounts = inside.grokAccounts;
  vi.spyOn(accounts, 'state').mockImplementation(state);
  const refresh = vi.spyOn(accounts, 'refresh').mockImplementation(async () => state());
  const switchTo = vi.spyOn(accounts, 'switch').mockImplementation(async (id: string) => {
    current = { ...saved.find((s) => s.id === id)! };
    return state();
  });
  const restart = vi
    .spyOn(supervisor, 'restartSession')
    .mockResolvedValue({ status: 'running' } as AgentSession);
  const screens = new Map<number, string>();
  const activity = new Map<number, 'idle' | 'running' | 'input'>();
  vi.spyOn(inside, 'sessionScreen').mockImplementation((id) => screens.get(id) ?? '> ');
  vi.spyOn(inside, 'sessionActivity').mockImplementation((row) => activity.get(row.id) ?? 'idle');
  const add = (provider = 'grok') => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO agent_sessions
      (project_id,name,provider_id,command_json,cwd,status,desired_state,supervise,created_at,started_at,log_path)
      VALUES (?,'fixture',?,?,?,'running','running',0,?,?,?)`,
        )
        .run(
          project,
          provider,
          '{"command":["grok"]}',
          root,
          new Date().toISOString(),
          new Date().toISOString(),
          path.join(root, String(Math.random()) + '.log'),
        ).lastInsertRowid,
    );
    inside.live.set(`session:${id}`, {});
    return id;
  };
  const settle = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  return { supervisor, inside, refresh, switchTo, restart, screens, activity, add, settle };
}

it('switches a verified exhausted login and restarts idle and blocked sessions only', async () => {
  const h = await setup(100);
  h.supervisor.setGrokAutoSwitch(true);
  const blocked = h.add();
  const idle = h.add();
  const working = h.add();
  const other = h.add('codex');
  h.screens.set(blocked, '┃  You hit your weekly limit.\n(○) Buy more credits');
  h.activity.set(working, 'running');
  h.inside.tickGrokRotation();
  await h.settle();
  expect(h.switchTo).toHaveBeenCalledWith('b');
  expect(h.restart).toHaveBeenCalledWith(blocked, { continuePrompt: true });
  expect(h.restart).toHaveBeenCalledWith(idle, { continuePrompt: false });
  expect(h.restart).not.toHaveBeenCalledWith(working, expect.anything());
  expect(h.restart).not.toHaveBeenCalledWith(other, expect.anything());
});

it('never switches on the screen message alone, but reads usage sooner', async () => {
  const h = await setup(60);
  h.supervisor.setGrokAutoSwitch(true);
  const blocked = h.add();
  h.screens.set(blocked, 'You hit your weekly limit.');
  h.inside.tickGrokRotation();
  await h.settle();
  expect(h.switchTo).not.toHaveBeenCalled();
  expect(h.refresh).toHaveBeenCalledWith('default');
});

it('does nothing while automatic rotation is off', async () => {
  const h = await setup(100);
  h.add();
  h.inside.tickGrokRotation();
  await h.settle();
  expect(h.switchTo).not.toHaveBeenCalled();
  expect(h.refresh).not.toHaveBeenCalled();
});

it('does not come straight back to the login it left', async () => {
  const h = await setup(100);
  h.supervisor.setGrokAutoSwitch(true);
  h.add();
  h.inside.tickGrokRotation();
  await h.settle();
  expect(h.switchTo).toHaveBeenCalledTimes(1);
  // Now on b, also verified out: a is skipped until its reset, so it stays put.
  vi.mocked(h.inside.grokAccounts.state).mockReturnValue({
    available: true,
    accounts: [
      { ...reading('b', 100), active: true },
      { ...reading('a', 0), active: false },
    ],
    defaultAccount: { ...reading('b', 100), active: true },
  });
  h.inside.tickGrokRotation();
  await h.settle();
  expect(h.switchTo).toHaveBeenCalledTimes(1);
});
