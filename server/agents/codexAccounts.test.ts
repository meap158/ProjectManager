import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../db.js';
import { insertProject } from '../store.js';
import { CodexAccounts } from './codexAccounts.js';
import { AgentSupervisor } from './supervisor.js';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function writeRolloutWithRateLimit(codexHome: string, usedPercent: number, resetsAtSec: number) {
  const dayDir = path.join(codexHome, 'sessions', '2026', '10', '17');
  mkdirSync(dayDir, { recursive: true });
  const line = JSON.stringify({
    timestamp: '2026-10-17T10:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        plan_type: 'pro',
        primary: {
          used_percent: usedPercent,
          window_minutes: 300,
          resets_at: resetsAtSec,
        },
      },
    },
  });
  writeFileSync(path.join(dayDir, 'rollout-2026-10-17T10-00-00-abc.jsonl'), `${line}\n`, 'utf8');
}

describe('CodexAccounts (PM-164)', () => {
  let tmpDir: string;
  let defaultCodexHome: string;
  let prevCodexHome: string | undefined;
  let db: Db;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'pm-codex-accounts-'));
    defaultCodexHome = path.join(tmpDir, 'default-codex');
    mkdirSync(defaultCodexHome, { recursive: true });
    prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = defaultCodexHome;
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('imports standard and flat OAuth auth.json files, extracts email/plan metadata, and syncs config.toml', () => {
    writeFileSync(path.join(defaultCodexHome, 'config.toml'), 'model = "gpt-5-codex"\n', 'utf8');
    const accounts = new CodexAccounts(tmpDir, db);

    const jwt = makeJwt({
      email: 'alice@example.com',
      'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' },
    });
    const state1 = accounts.importAccount(
      'Work Pro',
      JSON.stringify({ tokens: { id_token: jwt, access_token: 'acc-1', refresh_token: 'ref-1' } }),
    );
    expect(state1.accounts).toHaveLength(1);
    expect(state1.accounts[0]?.name).toBe('Work Pro');
    expect(state1.accounts[0]?.email).toBe('alice@example.com');
    expect(state1.accounts[0]?.plan).toBe('pro');

    const profile1 = accounts.profile(state1.accounts[0]!.id);
    expect(readFileSync(path.join(profile1.home, 'config.toml'), 'utf8')).toContain('gpt-5-codex');

    // Flat CLIProxyAPI / OAuth format (`codex-auth import --cpa` style)
    const state2 = accounts.importAccount(
      'Backup Plus',
      JSON.stringify({
        access_token: 'flat-access',
        refresh_token: 'flat-refresh',
        email: 'bob@example.com',
        plan: 'plus',
      }),
    );
    expect(state2.accounts).toHaveLength(2);
    const second = state2.accounts[1]!;
    expect(second.email).toBe('bob@example.com');
    expect(second.plan).toBe('plus');
    const savedAuth = JSON.parse(
      readFileSync(path.join(accounts.profile(second.id).home, 'auth.json'), 'utf8'),
    ) as { tokens?: { access_token?: string } };
    expect(savedAuth.tokens?.access_token).toBe('flat-access');
  });

  it('saves the current default CODEX_HOME login into the managed pool', () => {
    const jwt = makeJwt({
      email: 'default@example.com',
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
    });
    writeFileSync(
      path.join(defaultCodexHome, 'auth.json'),
      JSON.stringify({ tokens: { id_token: jwt, access_token: 'def-token' } }),
      'utf8',
    );
    const accounts = new CodexAccounts(tmpDir, db);
    expect(accounts.state().defaultAccount.available).toBe(true);
    expect(accounts.state().defaultAccount.email).toBe('default@example.com');

    const saved = accounts.saveCurrentAccount();
    expect(saved.accounts).toHaveLength(1);
    expect(saved.accounts[0]?.name).toBe('default@example.com');
    expect(saved.accounts[0]?.plan).toBe('plus');
    expect(saved.activeProfileId).toBe(saved.accounts[0]!.id);
    expect(accounts.selectedId()).toBe(saved.accounts[0]!.id);
    expect(existsSync(path.join(defaultCodexHome, 'auth.json'))).toBe(false);
    expect(
      readFileSync(path.join(accounts.profile(saved.accounts[0]!.id).home, 'auth.json'), 'utf8'),
    ).toContain('def-token');
  });

  it('switches active account, toggles autoSwitch, renames, and removes unused accounts', () => {
    const accounts = new CodexAccounts(tmpDir, db);
    const state = accounts.importAccount(
      'Team Account',
      JSON.stringify({ OPENAI_API_KEY: 'sk-test-12345' }),
    );
    const id = state.accounts[0]!.id;

    expect(accounts.selectedId()).toBe('default');
    const activated = accounts.setActive(id);
    expect(activated.activeProfileId).toBe(id);
    expect(accounts.selectedId()).toBe(id);

    const toggled = accounts.setAutoSwitch(false);
    expect(toggled.autoSwitch).toBe(false);

    const renamed = accounts.renameAccount(id, 'Renamed Account');
    expect(renamed.accounts[0]?.name).toBe('Renamed Account');

    const removed = accounts.removeAccount(id);
    expect(removed.accounts).toHaveLength(0);
    expect(removed.activeProfileId).toBeNull();
  });

  it('rotates to the next non-exhausted untried account on usage limits and migrates rollout files', () => {
    const accounts = new CodexAccounts(tmpDir, db);
    const s1 = accounts.importAccount('Acc 1', JSON.stringify({ OPENAI_API_KEY: 'sk-1' }));
    const s2 = accounts.importAccount('Acc 2', JSON.stringify({ OPENAI_API_KEY: 'sk-2' }));
    const id1 = s1.accounts[0]!.id;
    const id2 = s2.accounts[1]!.id;

    const nowMs = Date.parse('2026-10-17T10:05:00.000Z');
    const futureSec = Math.floor(Date.parse('2026-10-17T12:00:00.000Z') / 1000);

    // Mark Acc 1 as exhausted (100% used) and Acc 2 as having plenty of quota (20% used).
    writeRolloutWithRateLimit(accounts.profile(id1).home, 100, futureSec);
    writeRolloutWithRateLimit(accounts.profile(id2).home, 20, futureSec);

    const next = accounts.nextUnused('default', ['default'], nowMs);
    expect(next?.id).toBe(id2);

    // The helper can still copy a rollout file. Account switching does not: Codex rejects
    // resuming another login's thread.
    const rolloutRel = path.join('sessions', '2026', '10', '17', 'rollout-conv-123.jsonl');
    const srcRollout = path.join(defaultCodexHome, rolloutRel);
    mkdirSync(path.dirname(srcRollout), { recursive: true });
    writeFileSync(srcRollout, '{"id":"conv-123"}\n', 'utf8');
    writeFileSync(
      path.join(defaultCodexHome, 'session_index.jsonl'),
      '{"id":"conv-123"}\n',
      'utf8',
    );

    accounts.copyRolloutToHome(defaultCodexHome, accounts.profile(id2).home, srcRollout);
    expect(readFileSync(path.join(accounts.profile(id2).home, rolloutRel), 'utf8')).toBe(
      '{"id":"conv-123"}\n',
    );
    expect(readFileSync(path.join(accounts.profile(id2).home, 'session_index.jsonl'), 'utf8')).toBe(
      '{"id":"conv-123"}\n',
    );
  });

  it('stores saved-profile credentials in that profile, not the shared keyring', () => {
    writeFileSync(
      path.join(defaultCodexHome, 'config.toml'),
      'model = "gpt-5-codex"\ncli_auth_credentials_store = "keyring"\n',
      'utf8',
    );
    const accounts = new CodexAccounts(tmpDir, db);
    const state = accounts.importAccount('Genzy', JSON.stringify({ OPENAI_API_KEY: 'sk-genzy' }));
    const home = accounts.profile(state.accounts[0]!.id).home;
    const saved = readFileSync(path.join(home, 'config.toml'), 'utf8');
    expect(saved.startsWith('cli_auth_credentials_store = "file"\n')).toBe(true);
    expect(saved).not.toContain('keyring');
    expect(readFileSync(path.join(defaultCodexHome, 'config.toml'), 'utf8')).toContain('keyring');
  });

  it('repairs a credential-store key placed inside a TOML table', () => {
    const config =
      'model = "gpt-5-codex"\n[notice]\ncli_auth_credentials_store = "keyring"\nhide_warning = true\n';
    writeFileSync(path.join(defaultCodexHome, 'config.toml'), config);
    const accounts = new CodexAccounts(tmpDir, db);
    const state = accounts.importAccount('Work', JSON.stringify({ OPENAI_API_KEY: 'sk-test' }));
    const file = path.join(accounts.profile(state.accounts[0]!.id).home, 'config.toml');
    const repaired = readFileSync(file, 'utf8');
    expect(repaired).toBe(
      'cli_auth_credentials_store = "file"\nmodel = "gpt-5-codex"\n[notice]\nhide_warning = true\n',
    );
    accounts.profile(state.accounts[0]!.id);
    expect(readFileSync(file, 'utf8')).toBe(repaired);
    expect(readFileSync(path.join(defaultCodexHome, 'config.toml'), 'utf8')).toBe(config);
  });

  it('carries the conversation to the new login so the restarted CLI resumes it (PM-188)', async () => {
    const supervisor = new AgentSupervisor(db, path.join(tmpDir, 'logs'), { dataDir: tmpDir });
    try {
      await supervisor.ready;
      writeFileSync(path.join(defaultCodexHome, 'auth.json'), '{"OPENAI_API_KEY":"sk-default"}\n');
      const imported = supervisor.importCodexAccount(
        'Genzy',
        JSON.stringify({ OPENAI_API_KEY: 'sk-genzy' }),
      );
      const accountId = imported.accounts[0]!.id;
      const projectId = insertProject(db, 'carry', path.join(tmpDir, 'proj'));
      const resumeId = '019ef8dc-a4c1-7ae2-841a-e0f17c1e9b12';
      const rel = path.join(
        'sessions',
        '2026',
        '10',
        '18',
        `rollout-2026-10-18T00-00-00-${resumeId}.jsonl`,
      );
      const source = path.join(defaultCodexHome, rel);
      mkdirSync(path.dirname(source), { recursive: true });
      const lines = [
        { type: 'session_meta', payload: { id: resumeId } },
        { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'sealed' } },
        { type: 'response_item', payload: { type: 'message', role: 'user' } },
      ].map((item) => JSON.stringify(item));
      writeFileSync(source, `${lines.join('\n')}\n`);
      const sessionId = Number(
        db
          .prepare(
            `INSERT INTO agent_sessions
               (project_id, name, provider_id, command_json, resume_json, cwd, status,
                desired_state, supervise, created_at, started_at, log_path)
             VALUES (?, 'Codex', 'codex', ?, ?, ?, 'exited', 'stopped', 0, ?, ?, ?)`,
          )
          .run(
            projectId,
            JSON.stringify({
              command: ['codex'],
              env: { CODEX_HOME: defaultCodexHome },
              codexAccountId: 'default',
            }),
            JSON.stringify(['codex', 'resume', resumeId]),
            path.join(tmpDir, 'proj'),
            '2026-10-18T00:00:00.000Z',
            '2026-10-18T00:00:00.000Z',
            path.join(tmpDir, 'logs', 'session.log'),
          ).lastInsertRowid,
      );

      await supervisor.switchSessionCodexAccount(sessionId, accountId);

      const row = db
        .prepare('SELECT command_json, resume_json FROM agent_sessions WHERE id = ?')
        .get(sessionId) as { command_json: string; resume_json: string | null };
      const command = JSON.parse(row.command_json) as { codexFreshStart?: boolean };
      expect(command.codexFreshStart).toBeUndefined();
      expect(JSON.parse(row.resume_json!)).toEqual(['codex', 'resume', resumeId]);
      const copied = readFileSync(path.join(tmpDir, 'codex-accounts', accountId, rel), 'utf8');
      expect(copied).toContain('"message"');
      expect(copied).not.toContain('sealed');
      expect(readFileSync(source, 'utf8')).toContain('sealed'); // the old login keeps its own copy
    } finally {
      await supervisor.shutdown();
    }
  });

  it('starts a new conversation when switching Codex accounts with nothing to carry over', async () => {
    const supervisor = new AgentSupervisor(db, path.join(tmpDir, 'logs'), { dataDir: tmpDir });
    try {
      await supervisor.ready;
      writeFileSync(path.join(defaultCodexHome, 'auth.json'), '{"OPENAI_API_KEY":"sk-default"}\n');
      const imported = supervisor.importCodexAccount(
        'Genzy',
        JSON.stringify({ OPENAI_API_KEY: 'sk-genzy' }),
      );
      const accountId = imported.accounts[0]!.id;
      const projectId = insertProject(db, 'switch', path.join(tmpDir, 'proj'));
      const resumeId = '019ef8dc-a4c1-7ae2-841a-e0f17c1e9b12';
      const rolloutDir = path.join(defaultCodexHome, 'sessions', '2026', '10', '18');
      mkdirSync(rolloutDir, { recursive: true });
      writeFileSync(path.join(rolloutDir, 'rollout-old.jsonl'), '{"id":"old"}\n');
      const sessionId = Number(
        db
          .prepare(
            `INSERT INTO agent_sessions
               (project_id, name, provider_id, command_json, resume_json, cwd, status,
                desired_state, supervise, created_at, started_at, log_path)
             VALUES (?, 'Codex', 'codex', ?, ?, ?, 'exited', 'stopped', 0, ?, ?, ?)`,
          )
          .run(
            projectId,
            JSON.stringify({
              command: ['codex'],
              env: { CODEX_HOME: defaultCodexHome },
              codexAccountId: 'default',
            }),
            JSON.stringify(['codex', 'resume', resumeId]),
            path.join(tmpDir, 'proj'),
            '2026-10-18T00:00:00.000Z',
            '2026-10-18T00:00:00.000Z',
            path.join(tmpDir, 'logs', 'session.log'),
          ).lastInsertRowid,
      );

      await supervisor.switchSessionCodexAccount(sessionId, accountId);

      const row = db
        .prepare('SELECT command_json, resume_json FROM agent_sessions WHERE id = ?')
        .get(sessionId) as { command_json: string; resume_json: string | null };
      const command = JSON.parse(row.command_json) as {
        codexAccountId?: string;
        codexFreshStart?: boolean;
        env?: { CODEX_HOME?: string };
      };
      expect(row.resume_json).toBeNull();
      expect(command.codexFreshStart).toBe(true);
      expect(command.codexAccountId).toBe(accountId);
      expect(command.env?.CODEX_HOME).toBe(path.join(tmpDir, 'codex-accounts', accountId));
      expect(existsSync(path.join(tmpDir, 'codex-accounts', accountId, 'sessions'))).toBe(false);
    } finally {
      await supervisor.shutdown();
    }
  });

  it('applies the selected Codex account to every Codex session, not just the one switched', async () => {
    const supervisor = new AgentSupervisor(db, path.join(tmpDir, 'logs'), { dataDir: tmpDir });
    try {
      await supervisor.ready;
      writeFileSync(path.join(defaultCodexHome, 'auth.json'), '{"OPENAI_API_KEY":"sk-default"}\n');
      const imported = supervisor.importCodexAccount(
        'Genzy',
        JSON.stringify({ OPENAI_API_KEY: 'sk-genzy' }),
      );
      const accountId = imported.accounts[0]!.id;
      const projectId = insertProject(db, 'switch-all', path.join(tmpDir, 'proj-all'));
      const insert = (name: string, account: string, home: string) =>
        Number(
          db
            .prepare(
              `INSERT INTO agent_sessions
                 (project_id, name, provider_id, command_json, resume_json, cwd, status,
                  desired_state, supervise, created_at, started_at, log_path)
               VALUES (?, ?, 'codex', ?, ?, ?, 'exited', 'stopped', 0, ?, ?, ?)`,
            )
            .run(
              projectId,
              name,
              JSON.stringify({
                command: ['codex'],
                env: { CODEX_HOME: home },
                codexAccountId: account,
              }),
              JSON.stringify(['codex', 'resume', '019ef8dc-a4c1-7ae2-841a-e0f17c1e9b12']),
              path.join(tmpDir, 'proj-all'),
              '2026-10-18T00:00:00.000Z',
              '2026-10-18T00:00:00.000Z',
              path.join(tmpDir, 'logs', `${name}.log`),
            ).lastInsertRowid,
        );
      const first = insert('one', 'default', defaultCodexHome);
      const second = insert('two', 'default', defaultCodexHome);

      await supervisor.switchSessionCodexAccount(first, accountId);

      const homes = [first, second].map((id) => {
        const row = db
          .prepare('SELECT command_json, resume_json FROM agent_sessions WHERE id = ?')
          .get(id) as { command_json: string; resume_json: string | null };
        return {
          resume: row.resume_json,
          command: JSON.parse(row.command_json) as {
            codexAccountId?: string;
            env?: { CODEX_HOME?: string };
          },
        };
      });
      for (const session of homes) {
        expect(session.resume).toBeNull();
        expect(session.command.codexAccountId).toBe(accountId);
        expect(session.command.env?.CODEX_HOME).toBe(
          path.join(tmpDir, 'codex-accounts', accountId),
        );
      }
      expect(supervisor.codexAccountsState().activeProfileId).toBe(accountId);
      expect(supervisor.getSession(second)?.codexAccountId).toBe(accountId);
    } finally {
      await supervisor.shutdown();
    }
  });
  it('refreshes saved profile usage without changing the selected account or using global default credentials', async () => {
    const accounts = new CodexAccounts(tmpDir, db);
    const saved = accounts.importAccount(
      'Usage test',
      JSON.stringify({ OPENAI_API_KEY: 'fake-test-key' }),
    );
    const id = saved.accounts[0]!.id;
    accounts.setActive(id);
    const visited: string[] = [];
    const state = await accounts.refreshUsage(async (home) => {
      visited.push(home);
      return { status: 'expired', limits: null, checkedAt: new Date().toISOString() };
    });
    expect(visited).toEqual([path.join(tmpDir, 'codex-accounts', id)]);
    expect(state.activeProfileId).toBe(id);
    expect(state.accounts[0]?.usageStatus).toBe('expired');
    expect(state.accounts[0]?.limits).toBeNull();
    expect(existsSync(path.join(defaultCodexHome, 'auth.json'))).toBe(false);
  });

  it('keeps usage for every profile across restarts and re-reads only stale ones (PM-173)', async () => {
    const accounts = new CodexAccounts(tmpDir, db);
    for (const name of ['One', 'Two'])
      accounts.importAccount(name, JSON.stringify({ OPENAI_API_KEY: `fake-${name}` }));
    const [one, two] = accounts
      .state()
      .accounts.map((a) => path.join(tmpDir, 'codex-accounts', a.id));
    const limits = (used: number) => ({
      providerId: 'codex',
      windows: [{ label: '5-hour', windowMinutes: 300, usedPercent: used, resetsAt: null }],
      asOf: new Date().toISOString(),
      source: 'test',
    });
    const now = Date.now();
    const done = await accounts.refreshUsage(async (home) => ({
      status: 'fresh',
      limits: limits(home === one ? 40 : 70),
      checkedAt: new Date(now).toISOString(),
    }));
    expect(done.usageRefreshing).toBe(false);
    expect(done.accounts.map((a) => a.limits?.windows[0]?.usedPercent)).toEqual([40, 70]);

    // A restart: a new instance has the same usage from the database.
    const restarted = new CodexAccounts(tmpDir, db);
    expect(restarted.state().accounts.map((a) => a.limits?.windows[0]?.usedPercent)).toEqual([
      40, 70,
    ]);

    // Nothing is older than the limit: no background read starts.
    const visited: string[] = [];
    const reader = async (home: string) => {
      visited.push(home);
      return { status: 'unavailable' as const, limits: null, checkedAt: new Date().toISOString() };
    };
    restarted.refreshUsageIfStale(10 * 60_000, now + 60_000, reader);
    expect(restarted.state().usageRefreshing).toBe(false);

    // Later, both are stale: a background read starts; a failed read keeps the known numbers.
    restarted.refreshUsageIfStale(10 * 60_000, now + 11 * 60_000, reader);
    expect(restarted.state().usageRefreshing).toBe(true);
    await vi.waitFor(() => expect(restarted.state().usageRefreshing).toBe(false));
    expect(visited.sort()).toEqual([one, two].sort());
    const after = restarted.state().accounts;
    expect(after.map((a) => a.usageStatus)).toEqual(['unavailable', 'unavailable']);
    expect(after.map((a) => a.limits?.windows[0]?.usedPercent)).toEqual([40, 70]);
  });
});

describe('CodexAccounts usage per account (PM-173)', () => {
  let tmpDir: string;
  let prevCodexHome: string | undefined;
  let db: Db;
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'pm-codex-usage-'));
    mkdirSync(path.join(tmpDir, 'default-codex'), { recursive: true });
    prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(tmpDir, 'default-codex');
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads a login saved twice only once, from the default copy, and shares its usage', async () => {
    const auth = (email: string) =>
      JSON.stringify({
        tokens: { id_token: makeJwt({ email }), access_token: 'a', refresh_token: 'r' },
      });
    writeFileSync(path.join(tmpDir, 'default-codex', 'auth.json'), auth('same@example.com'));
    const accounts = new CodexAccounts(tmpDir, db);
    accounts.importAccount('Copy', auth('SAME@example.com'));
    accounts.importAccount('Other', auth('other@example.com'));
    const visited: string[] = [];
    const state = await accounts.refreshUsage(async (home) => {
      visited.push(path.basename(home));
      return {
        status: 'fresh',
        limits: {
          providerId: 'codex',
          windows: [{ label: '5-hour', windowMinutes: 300, usedPercent: 55, resetsAt: null }],
          asOf: new Date().toISOString(),
          source: 'test',
        },
        checkedAt: new Date().toISOString(),
      };
    });
    const other = state.accounts.find((a) => a.name === 'Other')!;
    // The default copy and the other account are read; the second copy is never started.
    expect(visited.sort()).toEqual(['default-codex', other.id].sort());
    const copy = state.accounts.find((a) => a.name === 'Copy')!;
    expect(copy.limits?.windows[0]?.usedPercent).toBe(55);
    expect(copy.usageStatus).toBe('fresh');
  });
});
