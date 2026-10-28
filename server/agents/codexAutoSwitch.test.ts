import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openDb } from '../db.js';
import { insertProject } from '../store.js';
import { AgentSupervisor } from './supervisor.js';
import type { CodexAccounts } from './codexAccounts.js';
import type { AgentSession } from '../../shared/types.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pm-auto-quota-'));
  const home = path.join(root, 'codex');
  mkdirSync(home);
  vi.stubEnv('CODEX_HOME', home);
  writeFileSync(path.join(home, 'auth.json'), '{"OPENAI_API_KEY":"current-fixture"}');
  const db = openDb(':memory:');
  const supervisor = new AgentSupervisor(db, path.join(root, 'logs'), { dataDir: root });
  await supervisor.ready;
  const inside = supervisor as unknown as {
    codexAccounts: CodexAccounts;
    live: Map<string, unknown>;
    waitingCodexRuns: Set<number>;
    starting: Set<string>;
    tickContinuation(): void;
    codexRotationReady(): boolean;
    waitForCodexRotation(
      run: { id: number; log_path: string },
      currentKey: string,
    ): Promise<boolean>;
    sessionActivity(row: { id: number }, last: string | null): 'idle' | 'running' | 'input';
    sessionScreen(id: number): string;
    usageLimitOnScreen(): { resetsAt: string | null } | undefined;
  };
  cleanups.push(async () => {
    inside.live.clear();
    await supervisor.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = insertProject(db, 'fixture', root);
  const accounts = inside.codexAccounts;
  const target = accounts.importAccount('Eligible', '{"OPENAI_API_KEY":"eligible-fixture"}')
    .accounts[0]!.id;
  vi.spyOn(accounts, 'refreshUsageIfStale').mockImplementation(() => undefined);
  vi.spyOn(inside, 'sessionActivity').mockReturnValue('idle');
  vi.spyOn(inside, 'sessionScreen').mockReturnValue('> ');
  vi.spyOn(inside, 'usageLimitOnScreen').mockReturnValue(undefined);
  const switchAccount = vi
    .spyOn(supervisor, 'switchSessionCodexAccount')
    .mockResolvedValue({ status: 'running' } as AgentSession);
  const add = (status = 'running') => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO agent_sessions
      (project_id,name,provider_id,command_json,cwd,status,desired_state,supervise,created_at,started_at,log_path)
      VALUES (?,'fixture','codex',?,?,?, ?,0,?,?,?)`,
        )
        .run(
          project,
          '{"command":["codex"]}',
          root,
          status,
          status === 'running' ? 'running' : 'stopped',
          new Date().toISOString(),
          new Date().toISOString(),
          path.join(root, String(Math.random()) + '.log'),
        ).lastInsertRowid,
    );
    if (status === 'running') inside.live.set(`session:${id}`, {});
    return id;
  };
  const quota = async (current = 100, destination = 20, age = 0) => {
    const at = new Date(Date.now() - age).toISOString();
    await accounts.refreshUsage(async (source) => ({
      status: 'fresh',
      checkedAt: at,
      limits: {
        providerId: 'codex',
        source: 'fixture',
        asOf: at,
        windows: [
          {
            label: '5-hour',
            windowMinutes: 300,
            usedPercent: source === home ? current : destination,
            resetsAt: null,
          },
          { label: 'Weekly', windowMinutes: 10080, usedPercent: 30, resetsAt: null },
        ],
      },
    }));
  };
  return { root, db, project, supervisor, inside, switchAccount, accounts, target, add, quota };
}
it('defers at 100% while any grace turn is working, then switches at idle without inventing Continue', async () => {
  const h = await setup();
  h.add();
  h.add();
  await h.quota();
  vi.mocked(h.inside.sessionActivity).mockReturnValue('running');
  h.inside.tickContinuation();
  expect(h.switchAccount).not.toHaveBeenCalled();
  vi.mocked(h.inside.sessionActivity).mockReturnValue('idle');
  h.inside.tickContinuation();
  expect(h.switchAccount).toHaveBeenCalledWith(
    expect.any(Number),
    h.target,
    expect.objectContaining({ automatic: true, continuePrompt: false }),
  );
});
it.each(['> unsent draft', '', 'unreadable terminal'])(
  'allows rotation with prompt text %j at idle',
  async (screen) => {
    const h = await setup();
    h.add();
    await h.quota();
    vi.mocked(h.inside.sessionScreen).mockReturnValue(screen);
    h.inside.tickContinuation();
    expect(h.switchAccount).toHaveBeenCalledOnce();
  },
);

it('continues a limit-blocked session after a safe switch', async () => {
  const h = await setup();
  const id = h.add();
  await h.quota();
  vi.mocked(h.inside.usageLimitOnScreen).mockReturnValue({ resetsAt: null });
  h.inside.tickContinuation();
  expect(h.switchAccount).toHaveBeenCalledWith(
    id,
    h.target,
    expect.objectContaining({ automatic: true, continuePrompt: true }),
  );
});
it('treats a session stopped at the limit message, or an unreadable idle screen, as safe to move', async () => {
  const h = await setup();
  h.add();
  await h.quota();
  vi.mocked(h.inside.sessionScreen).mockReturnValue('> ');
  vi.mocked(h.inside.sessionActivity).mockReturnValue(null as never);
  h.inside.tickContinuation();
  expect(h.switchAccount).toHaveBeenCalledOnce();
});
it('defers for an approval prompt, pending input, or an active run', async () => {
  const h = await setup();
  const id = h.add();
  await h.quota();
  vi.mocked(h.inside.sessionScreen).mockReturnValue('> ');
  vi.mocked(h.inside.sessionActivity).mockReturnValue('input');
  h.inside.tickContinuation();
  expect(h.switchAccount).not.toHaveBeenCalled();
  vi.mocked(h.inside.sessionActivity).mockReturnValue('idle');
  h.db
    .prepare('INSERT INTO agent_input_queue(session_id,data,created_at) VALUES (?,?,?)')
    .run(id, 'queued', new Date().toISOString());
  h.inside.tickContinuation();
  expect(h.switchAccount).not.toHaveBeenCalled();
  h.db.prepare('DELETE FROM agent_input_queue WHERE session_id = ?').run(id);
  const run = Number(
    h.db
      .prepare(
        `INSERT INTO agent_runs(project_id,name,provider_id,command_json,status,created_at,log_path) VALUES (?,'run','codex','{}','running',?,?)`,
      )
      .run(h.project, new Date().toISOString(), path.join(h.root, 'run.log')).lastInsertRowid,
  );
  h.inside.tickContinuation();
  expect(h.switchAccount).not.toHaveBeenCalled();
  h.db.prepare("UPDATE agent_runs SET status = 'succeeded' WHERE id = ?").run(run);
  h.inside.tickContinuation();
  expect(h.switchAccount).toHaveBeenCalledOnce();
});
it('stays put for no eligible quota, stale reports, a disabled toggle, or only Ended work', async () => {
  const h = await setup();
  const id = h.add();
  await h.quota(100, 100);
  h.inside.tickContinuation();
  expect(h.switchAccount).not.toHaveBeenCalled();
  await h.quota(100, 20, 120000);
  h.inside.tickContinuation();
  expect(h.switchAccount).not.toHaveBeenCalled();
  await h.quota(99.6);
  h.inside.tickContinuation();
  expect(h.switchAccount).not.toHaveBeenCalled();
  await h.quota();
  h.accounts.setAutoSwitch(false);
  h.inside.tickContinuation();
  expect(h.switchAccount).not.toHaveBeenCalled();
  h.accounts.setAutoSwitch(true);
  h.db
    .prepare("UPDATE agent_sessions SET status='exited', desired_state='stopped' WHERE id=?")
    .run(id);
  h.inside.tickContinuation();
  expect(h.switchAccount).not.toHaveBeenCalled();
});

it('cancels a waiting rotation when its run is stopped and leaves the account unchanged', async () => {
  const h = await setup();
  h.add();
  vi.mocked(h.inside.sessionActivity).mockReturnValue('running');
  const log_path = path.join(h.root, 'waiting.log');
  const id = Number(
    h.db
      .prepare(
        `INSERT INTO agent_runs(project_id,name,provider_id,command_json,status,created_at,log_path) VALUES (?,'waiting','codex','{}','running',?,?)`,
      )
      .run(h.project, new Date().toISOString(), log_path).lastInsertRowid,
  );
  h.inside.waitingCodexRuns.add(id);
  const selected = h.accounts.selectedId();
  vi.useFakeTimers();
  const waiting = h.inside.waitForCodexRotation({ id, log_path }, selected);
  await h.supervisor.stopRun(id);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await waiting).toBe(false);
  expect(h.accounts.selectedId()).toBe(selected);
  expect(h.switchAccount).not.toHaveBeenCalled();
});

it('does not let another provider or a limit-blocked starting run veto rotation', async () => {
  const h = await setup();
  h.add();
  await h.quota();
  const run = Number(
    h.db
      .prepare(
        `INSERT INTO agent_runs(project_id,name,provider_id,command_json,status,created_at,log_path) VALUES (?,'waiting','codex','{}','running',?,?)`,
      )
      .run(h.project, new Date().toISOString(), path.join(h.root, 'blocked.log')).lastInsertRowid,
  );
  h.inside.starting.add(`run:${run}`);
  h.inside.waitingCodexRuns.add(run);
  h.inside.starting.add('session:99999');
  expect(h.inside.codexRotationReady()).toBe(true);
  h.inside.tickContinuation();
  expect(h.switchAccount).not.toHaveBeenCalled(); // The waiting run owns the switch.
  h.inside.waitingCodexRuns.delete(run);
  expect(h.inside.codexRotationReady()).toBe(false);
});

it('reports the same busy guard in Settings and exposes failed attempts for retry', async () => {
  const h = await setup();
  const id = h.add();
  await h.quota();
  vi.mocked(h.inside.sessionActivity).mockReturnValue('running');
  expect(h.supervisor.codexAccountsState().rotation).toMatchObject({
    waiting: `Codex session "fixture" (#${id}) is still working.`,
    error: null,
  });
  expect(Date.parse(h.supervisor.codexAccountsState().rotation!.nextCheckAt)).toBeGreaterThan(
    Date.now(),
  );
  vi.mocked(h.inside.sessionActivity).mockReturnValue('idle');
  h.switchAccount.mockRejectedValueOnce(new Error('Conversation could not be carried'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.inside.tickContinuation();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.supervisor.codexAccountsState().rotation?.error).toBe(
    'Conversation could not be carried',
  );
  h.inside.tickContinuation();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.switchAccount).toHaveBeenCalledTimes(2);
  expect(h.supervisor.codexAccountsState().rotation?.error).toBeNull();
});
