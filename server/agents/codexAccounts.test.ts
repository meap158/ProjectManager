import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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

  it('defaults profiles into rotation, persists opt-out and preserves manual selection', () => {
    const accounts = new CodexAccounts(tmpDir, db);
    const state = accounts.importAccount(
      'Optional',
      JSON.stringify({ access_token: 'test-token' }),
    );
    const id = state.accounts[0]!.id;
    expect(state.accounts[0]!.autoSwitchEligible).toBe(true);
    expect(accounts.nextUnused('default', ['default'])).toBeNull();
    accounts.setAutoSwitchEligible(id, false);
    const reloaded = new CodexAccounts(tmpDir, db);
    expect(reloaded.state().accounts[0]!.autoSwitchEligible).toBe(false);
    expect(reloaded.nextUnused('default', ['default'])).toBeNull();
    expect(reloaded.setActive(id).activeProfileId).toBe(id);
    reloaded.setAutoSwitchEligible(id, true);
    expect(reloaded.nextUnused('default', ['default'])).toBeNull();
    expect(() => reloaded.setAutoSwitchEligible('missing', false)).toThrow('not found');
  });

  it('copies multi-chunk rollouts without reading them as a single string', () => {
    const accounts = new CodexAccounts(tmpDir, db);
    const state = accounts.importAccount('Chunked', JSON.stringify({ access_token: 'test-token' }));
    const target = accounts.profile(state.accounts[0]!.id);
    const id = '019ef8dc-a4c1-7ae2-841a-e0f17c1e9b14';
    const dir = path.join(defaultCodexHome, 'sessions', '2026');
    mkdirSync(dir, { recursive: true });
    const text = JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', text: 'x'.repeat(2_100_000) },
    });
    const sealed = JSON.stringify({
      type: 'response_item',
      payload: { type: 'reasoning', encrypted_content: 'sealed' },
    });
    writeFileSync(path.join(dir, `rollout-2026-${id}.jsonl`), text + '\n' + sealed + '\n' + text);
    expect(accounts.carryConversation(defaultCodexHome, target.home, id)).toBe(true);
    expect(readFileSync(accounts.findRollout(target.home, id)!, 'utf8')).toBe(text + '\n' + text);
  });

  it('copies only the lines a rollout gained since the last sync', () => {
    const accounts = new CodexAccounts(tmpDir, db);
    const target = accounts.profile(
      accounts.importAccount('Grow', JSON.stringify({ access_token: 'test-token' })).accounts[0]!
        .id,
    );
    const id = '019ef8dc-a4c1-7ae2-841a-e0f17c1e9b15';
    const file = path.join(defaultCodexHome, 'sessions', '2026', `rollout-2026-${id}.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    const sealed = '{"type":"response_item","payload":{"type":"reasoning"}}\n';
    writeFileSync(file, '{"n":1}\n' + sealed);
    expect(accounts.carryConversation(defaultCodexHome, target.home, id)).toBe(true);
    const copy = accounts.findRollout(target.home, id)!;
    expect(readFileSync(copy, 'utf8')).toBe('{"n":1}\n');
    // Same size, so the copy still looks untouched: a changed byte proves the prefix isn't re-read.
    writeFileSync(copy, '{"n":9}\n');
    appendFileSync(file, '{"n":2}\n' + sealed + '{"n":3}\n');
    expect(accounts.carryConversation(defaultCodexHome, target.home, id)).toBe(true);
    expect(readFileSync(copy, 'utf8')).toBe('{"n":9}\n{"n":2}\n{"n":3}\n');
  });

  it('switching to Default never copies a profile smaller copy over the original', () => {
    const accounts = new CodexAccounts(tmpDir, db);
    const profile = accounts.profile(
      accounts.importAccount('Copy', JSON.stringify({ access_token: 'test-token' })).accounts[0]!
        .id,
    );
    const id = '019ef8dc-a4c1-7ae2-841a-e0f17c1e9b16';
    const name = `rollout-2026-10-18-${id}.jsonl`;
    const original = path.join(defaultCodexHome, 'sessions', '2026', '10', '18', name);
    const copy = path.join(profile.home, 'sessions', '2026', '10', '18', name);
    mkdirSync(path.dirname(original), { recursive: true });
    mkdirSync(path.dirname(copy), { recursive: true });
    const sealed = '{"type":"response_item","payload":{"type":"reasoning"}}\n';
    const text = '{"n":1}\n' + sealed + '{"n":2}\n';
    writeFileSync(original, text);
    writeFileSync(copy, '{"n":1}\n{"n":2}\n'); // Filtered copy, made later: newer, smaller.
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(original, past, past);
    accounts.setActive(profile.id);
    accounts.setActive(null);
    expect(readFileSync(original, 'utf8')).toBe(text);
    expect(statSync(original).mtimeMs).toBeCloseTo(past.getTime(), -2);
  });

  it('switching makes a saved login the default one and keeps the login it replaces (PM-243)', () => {
    const login = (email: string, token: string, refreshedAt: string) =>
      JSON.stringify({
        tokens: {
          id_token: makeJwt({ email }),
          access_token: token,
          refresh_token: `r-${token}`,
          account_id: `acct-${email}`,
        },
        last_refresh: refreshedAt,
      });
    const defaultFile = path.join(defaultCodexHome, 'auth.json');
    writeFileSync(defaultFile, login('first@example.com', 'first-1', '2026-10-01T00:00:00Z'));
    const accounts = new CodexAccounts(tmpDir, db);
    const second = accounts.importAccount(
      'Second',
      login('second@example.com', 'second-1', '2026-10-01T00:00:00Z'),
    ).accounts[0]!;
    const rollout = path.join(defaultCodexHome, 'sessions', '2026', '10', '18', 'rollout-a.jsonl');
    mkdirSync(path.dirname(rollout), { recursive: true });
    writeFileSync(rollout, '{"type":"session_meta"}\n');

    // The default login was never saved: switching saves it first, then replaces it.
    let state = accounts.setActive(second.id);
    expect(readFileSync(defaultFile, 'utf8')).toContain('second-1');
    expect(state.activeProfileId).toBe(second.id);
    expect(accounts.selectedProfile()).toMatchObject({ id: second.id, home: defaultCodexHome });
    const first = state.accounts.find((a) => a.email === 'first@example.com')!;
    expect(readFileSync(path.join(accounts.profile(first.id).home, 'auth.json'), 'utf8')).toContain(
      'first-1',
    );
    // Conversations stay where every CLI runs.
    expect(existsSync(rollout)).toBe(true);

    // Codex refreshed the second login in ~/.codex: switching away writes that back.
    writeFileSync(defaultFile, login('second@example.com', 'second-2', '2026-10-05T00:00:00Z'));
    expect(accounts.state().activeProfileId).toBe(second.id);
    state = accounts.setActive(first.id);
    expect(readFileSync(defaultFile, 'utf8')).toContain('first-1');
    expect(state.activeProfileId).toBe(first.id);
    expect(
      readFileSync(path.join(accounts.profile(second.id).home, 'auth.json'), 'utf8'),
    ).toContain('second-2');
    expect(state.accounts).toHaveLength(2); // No duplicate of a login that was already saved.

    // A manual `codex login` shows as the account in use.
    writeFileSync(defaultFile, login('second@example.com', 'second-3', '2026-10-06T00:00:00Z'));
    expect(accounts.state().activeProfileId).toBe(second.id);
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
    // The login stays where the CLIs run; saving again adds no second copy.
    expect(existsSync(path.join(defaultCodexHome, 'auth.json'))).toBe(true);
    expect(accounts.saveCurrentAccount().accounts).toHaveLength(1);
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

  it('rotates to the next non-exhausted untried account on usage limits and migrates rollout files', async () => {
    writeFileSync(
      path.join(defaultCodexHome, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'current' }),
    );
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
    await accounts.refreshUsage(async (home) => ({
      status: 'fresh',
      checkedAt: new Date(nowMs).toISOString(),
      limits: {
        providerId: 'codex',
        source: 'test',
        asOf: new Date(nowMs).toISOString(),
        windows: [
          {
            label: '5-hour',
            windowMinutes: 300,
            usedPercent: home === accounts.profile(id2).home ? 20 : 100,
            resetsAt: new Date(futureSec * 1000).toISOString(),
          },
        ],
      },
    }));

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

  it('reports account-switch restart progress throughout the stopped-process gap', async () => {
    const supervisor = new AgentSupervisor(db, path.join(tmpDir, 'logs'), { dataDir: tmpDir });
    try {
      await supervisor.ready;
      writeFileSync(path.join(defaultCodexHome, 'auth.json'), '{"OPENAI_API_KEY":"default"}');
      const accountId = supervisor.importCodexAccount('Next', '{"OPENAI_API_KEY":"next"}')
        .accounts[0]!.id;
      const projectId = insertProject(db, 'switch-progress', tmpDir);
      const id = Number(
        db
          .prepare(
            `INSERT INTO agent_sessions
        (project_id, name, provider_id, command_json, cwd, status, desired_state, supervise, created_at, started_at, log_path)
        VALUES (?, 'Codex', 'codex', ?, ?, 'running', 'running', 0, ?, ?, ?)`,
          )
          .run(
            projectId,
            JSON.stringify({ command: ['codex'], codexAccountId: 'default' }),
            tmpDir,
            new Date().toISOString(),
            new Date().toISOString(),
            path.join(tmpDir, 'logs', 'switch.log'),
          ).lastInsertRowid,
      );
      let release!: () => void;
      const stopped = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(supervisor, 'stopSession').mockImplementation(async () => {
        db.prepare(
          "UPDATE agent_sessions SET status = 'killed', desired_state = 'stopped' WHERE id = ?",
        ).run(id);
        await stopped;
        return supervisor.getSession(id);
      });
      vi.spyOn(supervisor, 'startSession').mockImplementation(async () => {
        expect(supervisor.getSession(id)?.restartProgress).toBe('starting');
        db.prepare(
          "UPDATE agent_sessions SET status = 'running', desired_state = 'running' WHERE id = ?",
        ).run(id);
        return supervisor.getSession(id)!;
      });
      const thread = '019ef8dc-a4c1-7ae2-841a-e0f17c1e9b12';
      const folder = path.join(defaultCodexHome, 'sessions', '2026', '10', '18');
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        path.join(folder, `rollout-${thread}.jsonl`),
        JSON.stringify({
          type: 'session_meta',
          payload: { id: thread, cwd: tmpDir, timestamp: new Date().toISOString() },
        }) + '\n',
      );
      db.prepare('UPDATE agent_sessions SET resume_json = ? WHERE id = ?').run(
        JSON.stringify(['codex', 'resume', thread]),
        id,
      );
      const pending = supervisor.switchSessionCodexAccount(id, accountId, { continuePrompt: true });
      expect(supervisor.getSession(id)).toMatchObject({
        status: 'killed',
        restartProgress: 'stopping',
      });
      release();
      expect(await pending).toMatchObject({ status: 'running', restartProgress: 'restoring' });
      expect(
        (
          db
            .prepare('SELECT count(*) AS n FROM agent_input_queue WHERE session_id = ?')
            .get(id) as { n: number }
        ).n,
      ).toBe(1);
    } finally {
      vi.restoreAllMocks();
      await supervisor.shutdown();
    }
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

      await expect(
        supervisor.switchSessionCodexAccount(sessionId, accountId, { automatic: true }),
      ).rejects.toThrow('Session ended');
      supervisor.setActiveCodexAccount(accountId, { activeOnly: true });
      expect(
        (
          db.prepare('SELECT command_json FROM agent_sessions WHERE id = ?').get(sessionId) as {
            command_json: string;
          }
        ).command_json,
      ).toContain('"codexAccountId":"default"');
      await supervisor.switchSessionCodexAccount(sessionId, accountId);

      const row = db
        .prepare('SELECT command_json, resume_json FROM agent_sessions WHERE id = ?')
        .get(sessionId) as { command_json: string; resume_json: string | null };
      const command = JSON.parse(row.command_json) as {
        codexFreshStart?: boolean;
        env?: Record<string, string>;
      };
      // Like a manual `codex login`: the new login lands in ~/.codex and the CLI resumes the
      // same conversation there (PM-243). Nothing is copied into the profile folder.
      expect(command.codexFreshStart).toBeUndefined();
      expect(command.env?.CODEX_HOME).toBe(defaultCodexHome);
      expect(JSON.parse(row.resume_json!)).toEqual(['codex', 'resume', resumeId]);
      expect(readFileSync(path.join(defaultCodexHome, 'auth.json'), 'utf8')).toContain('sk-genzy');
      expect(readFileSync(source, 'utf8')).toContain('"message"');
      expect(existsSync(path.join(tmpDir, 'codex-accounts', accountId, rel))).toBe(false);
    } finally {
      await supervisor.shutdown();
    }
  });

  it('refuses an account switch when its pinned conversation is missing', async () => {
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

      await expect(supervisor.switchSessionCodexAccount(sessionId, accountId)).rejects.toThrow(
        'exact Codex conversation',
      );

      const row = db
        .prepare('SELECT command_json, resume_json FROM agent_sessions WHERE id = ?')
        .get(sessionId) as { command_json: string; resume_json: string | null };
      const command = JSON.parse(row.command_json) as {
        codexAccountId?: string;
        codexFreshStart?: boolean;
        env?: { CODEX_HOME?: string };
      };
      expect(JSON.parse(row.resume_json!)).toEqual(['codex', 'resume', resumeId]);
      expect(command.codexFreshStart).toBeUndefined();
      expect(command.codexAccountId).toBe('default');
      expect(command.env?.CODEX_HOME).toBe(defaultCodexHome);
      expect(existsSync(path.join(tmpDir, 'codex-accounts', accountId, 'sessions'))).toBe(false);
    } finally {
      await supervisor.shutdown();
    }
  });

  it('one running session with no findable conversation does not block the account switch', async () => {
    const supervisor = new AgentSupervisor(db, path.join(tmpDir, 'logs'), { dataDir: tmpDir });
    try {
      await supervisor.ready;
      writeFileSync(path.join(defaultCodexHome, 'auth.json'), '{"OPENAI_API_KEY":"sk-default"}\n');
      const accountId = supervisor.importCodexAccount(
        'Genzy',
        JSON.stringify({ OPENAI_API_KEY: 'sk-genzy' }),
      ).accounts[0]!.id;
      const projectId = insertProject(db, 'lost', path.join(tmpDir, 'proj'));
      // Begun under a saved login: its rollout is in no home the switch looks in.
      const sessionId = Number(
        db
          .prepare(
            `INSERT INTO agent_sessions
               (project_id, name, provider_id, command_json, resume_json, cwd, status,
                desired_state, supervise, created_at, started_at, log_path)
             VALUES (?, 'Codex', 'codex', ?, ?, ?, 'running', 'running', 0, ?, ?, ?)`,
          )
          .run(
            projectId,
            JSON.stringify({
              command: ['codex'],
              env: { CODEX_HOME: defaultCodexHome },
              codexAccountId: 'default',
            }),
            JSON.stringify(['codex', 'resume', '019ef8dc-a4c1-7ae2-841a-e0f17c1e9b19']),
            path.join(tmpDir, 'proj'),
            '2026-10-18T00:00:00.000Z',
            '2026-10-18T00:00:00.000Z',
            path.join(tmpDir, 'logs', 'lost.log'),
          ).lastInsertRowid,
      );
      expect(supervisor.setActiveCodexAccount(accountId).activeProfileId).toBe(accountId);
      expect(readFileSync(path.join(defaultCodexHome, 'auth.json'), 'utf8')).toContain('sk-genzy');
      // Left exactly as it was, so a restart cannot lose its conversation.
      const row = db
        .prepare('SELECT command_json, status FROM agent_sessions WHERE id = ?')
        .get(sessionId) as { command_json: string; status: string };
      expect(row.command_json).toContain('"codexAccountId":"default"');
      expect(row.status).toBe('running');
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
              JSON.stringify([
                'codex',
                'resume',
                name === 'one'
                  ? '019ef8dc-a4c1-7ae2-841a-e0f17c1e9b12'
                  : '019ef8dc-a4c1-7ae2-841a-e0f17c1e9b13',
              ]),
              path.join(tmpDir, 'proj-all'),
              '2026-10-18T00:00:00.000Z',
              '2026-10-18T00:00:00.000Z',
              path.join(tmpDir, 'logs', `${name}.log`),
            ).lastInsertRowid,
        );
      const folder = path.join(defaultCodexHome, 'sessions', '2026', '10', '18');
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        path.join(folder, 'rollout-019ef8dc-a4c1-7ae2-841a-e0f17c1e9b12.jsonl'),
        '{}\n',
      );
      writeFileSync(
        path.join(folder, 'rollout-019ef8dc-a4c1-7ae2-841a-e0f17c1e9b13.jsonl'),
        '{}\n',
      );
      const first = insert('one', 'default', defaultCodexHome);
      const second = insert('two', 'default', defaultCodexHome);

      await supervisor.switchSessionCodexAccount(first, accountId);
      const otherId = supervisor
        .importCodexAccount('Other', '{"OPENAI_API_KEY":"other"}')
        .accounts.find((a) => a.name === 'Other')!.id;
      await supervisor.switchSessionCodexAccount(second, otherId);
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
      for (const [index, session] of homes.entries()) {
        // Account changes preserve the exact pinned conversation.
        expect(JSON.parse(session.resume!)).toEqual([
          'codex',
          'resume',
          index === 0
            ? '019ef8dc-a4c1-7ae2-841a-e0f17c1e9b12'
            : '019ef8dc-a4c1-7ae2-841a-e0f17c1e9b13',
        ]);
        expect(session.command.codexAccountId).toBe(accountId);
        expect(session.command.env?.CODEX_HOME).toBe(defaultCodexHome);
      }
      expect(supervisor.codexAccountsState().activeProfileId).toBe(accountId);
      expect(supervisor.getSession(second)?.codexAccountId).toBe(accountId);
    } finally {
      await supervisor.shutdown();
    }
  });
  it('reads the active login usage from ~/.codex, never from its stale saved copy (PM-243)', async () => {
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
    expect(visited).toEqual([defaultCodexHome]);
    expect(state.activeProfileId).toBe(id);
    expect(state.accounts[0]?.usageStatus).toBe('expired');
    expect(state.accounts[0]?.limits).toBeNull();
    expect(readFileSync(path.join(defaultCodexHome, 'auth.json'), 'utf8')).toContain(
      'fake-test-key',
    );
  });

  it('a switch moves usage with the logins, not the ~/.codex folder (PM-243)', async () => {
    const login = (email: string) =>
      JSON.stringify({ tokens: { id_token: makeJwt({ email }), access_token: email } });
    writeFileSync(path.join(defaultCodexHome, 'auth.json'), login('a@example.com'));
    const accounts = new CodexAccounts(tmpDir, db);
    const a = accounts.importAccount('A', login('a@example.com')).accounts[0]!;
    const b = accounts.importAccount('B', login('b@example.com')).accounts[1]!;
    const limits = (used: number) => ({
      providerId: 'codex',
      windows: [{ label: '5-hour', windowMinutes: 300, usedPercent: used, resetsAt: null }],
      asOf: new Date().toISOString(),
      source: 'test',
    });
    // A is in ~/.codex (read there, at 100%); B is read from its own folder (10%).
    await accounts.refreshUsage(async (home) => ({
      status: 'fresh',
      limits: limits(home === defaultCodexHome ? 100 : 10),
      checkedAt: new Date().toISOString(),
    }));
    const used = () =>
      Object.fromEntries(
        accounts.state().accounts.map((x) => [x.name, x.limits?.windows[0]?.usedPercent]),
      );
    expect(used()).toEqual({ A: 100, B: 10 });
    accounts.setActive(b.id);
    // B now lives in ~/.codex: it shows its own 10%, not A's 100% left on the folder.
    expect(used()).toEqual({ A: 100, B: 10 });
    expect(accounts.state().defaultAccount.limits?.windows[0]?.usedPercent).toBe(10);
    accounts.setActive(a.id);
    expect(used()).toEqual({ A: 100, B: 10 });
  });

  it('discards usage finishing after a default account switch and ignores shared rollout quota', async () => {
    const login = (email: string) =>
      JSON.stringify({ tokens: { id_token: makeJwt({ email }), access_token: email } });
    writeFileSync(path.join(defaultCodexHome, 'auth.json'), login('a@example.com'));
    const accounts = new CodexAccounts(tmpDir, db);
    accounts.importAccount('A', login('a@example.com'));
    const b = accounts.importAccount('B', login('b@example.com')).accounts[1]!;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = accounts.refreshUsage(async (home) => {
      if (home === defaultCodexHome) await waiting;
      return {
        status: 'fresh',
        checkedAt: new Date().toISOString(),
        limits: {
          providerId: 'codex',
          source: 'test',
          asOf: new Date().toISOString(),
          windows: [
            {
              label: '5-hour',
              windowMinutes: 300,
              usedPercent: home === defaultCodexHome ? 100 : 15,
              resetsAt: null,
            },
          ],
        },
      };
    });
    accounts.setActive(b.id);
    writeRolloutWithRateLimit(defaultCodexHome, 100, Math.floor(Date.now() / 1000) + 3600);
    release();
    await refresh;
    expect(accounts.state().defaultAccount.limits).toBeNull();
    await accounts.refreshUsage(async () => ({
      status: 'fresh',
      checkedAt: new Date().toISOString(),
      limits: {
        providerId: 'codex',
        source: 'test',
        asOf: new Date().toISOString(),
        windows: [{ label: '5-hour', windowMinutes: 300, usedPercent: 15, resetsAt: null }],
      },
    }));
    expect(accounts.state().defaultAccount.limits?.windows[0]?.usedPercent).toBe(15);
    expect(
      accounts.state().accounts.find((a) => a.id === b.id)?.limits?.windows[0]?.usedPercent,
    ).toBe(15);
  });

  it('rejects cached quota after external login replacement, including across restart', async () => {
    const login = (id: string) =>
      JSON.stringify({
        tokens: {
          account_id: id,
          id_token: makeJwt({ email: 'same@example.com' }),
          access_token: id,
        },
      });
    writeFileSync(path.join(defaultCodexHome, 'auth.json'), login('account-a'));
    const accounts = new CodexAccounts(tmpDir, db);
    await accounts.refreshUsage(async () => ({
      status: 'fresh',
      checkedAt: new Date().toISOString(),
      limits: {
        providerId: 'codex',
        source: 'test',
        asOf: new Date().toISOString(),
        windows: [{ label: '5-hour', windowMinutes: 300, usedPercent: 99, resetsAt: null }],
      },
    }));
    writeFileSync(path.join(defaultCodexHome, 'auth.json'), login('account-b'));
    expect(accounts.state().defaultAccount.limits).toBeNull();
    expect(new CodexAccounts(tmpDir, db).state().defaultAccount.limits).toBeNull();
  });

  it('failed refresh preserves the quota observation time and does not present it as fresh', async () => {
    writeFileSync(
      path.join(defaultCodexHome, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'test' }),
    );
    const accounts = new CodexAccounts(tmpDir, db);
    const asOf = '2026-10-24T00:00:00Z';
    await accounts.refreshUsage(async () => ({
      status: 'fresh',
      checkedAt: asOf,
      limits: {
        providerId: 'codex',
        source: 'test',
        asOf,
        windows: [{ label: '5-hour', windowMinutes: 300, usedPercent: 20, resetsAt: null }],
      },
    }));
    const state = await accounts.refreshUsage(async () => ({
      status: 'unavailable',
      checkedAt: '2026-10-24T00:01:00Z',
      limits: null,
    }));
    expect(state.defaultAccount.usageStatus).toBe('unavailable');
    expect(state.defaultAccount.usageCheckedAt).toBe(asOf);
    expect(state.defaultAccount.limits?.windows[0]?.usedPercent).toBe(20);
  });

  it('individual refresh of the active profile reads only its canonical default credential', async () => {
    const accounts = new CodexAccounts(tmpDir, db);
    const a = accounts.importAccount('A', JSON.stringify({ OPENAI_API_KEY: 'test-a' }))
      .accounts[0]!;
    accounts.importAccount('B', JSON.stringify({ OPENAI_API_KEY: 'test-b' }));
    accounts.setActive(a.id);
    const reader = vi.fn(async () => ({
      status: 'unavailable' as const,
      checkedAt: new Date().toISOString(),
      limits: null,
    }));
    await accounts.refreshAccountUsage(a.id, reader);
    expect(reader.mock.calls).toHaveLength(1);
    expect(reader).toHaveBeenCalledWith(defaultCodexHome);
  });

  it('requires verified exhaustion and ranks fresh candidates by 5-hour quota first', async () => {
    writeFileSync(
      path.join(defaultCodexHome, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'current' }),
    );
    const accounts = new CodexAccounts(tmpDir, db);
    const a = accounts.importAccount('A', JSON.stringify({ OPENAI_API_KEY: 'a' })).accounts[0]!;
    const b = accounts.importAccount('B', JSON.stringify({ OPENAI_API_KEY: 'b' })).accounts[1]!;
    const now = Date.now();
    const read = (used: number, status: 'fresh' | 'unavailable' = 'fresh', age = 0) =>
      accounts.refreshUsage(async (home) => ({
        status,
        checkedAt: new Date(now - age).toISOString(),
        limits: {
          providerId: 'codex',
          source: 'test',
          asOf: new Date(now - age).toISOString(),
          windows: [
            {
              label: '5-hour',
              windowMinutes: 300,
              usedPercent:
                home === defaultCodexHome ? used : home === accounts.profile(a.id).home ? 10 : 30,
              resetsAt: new Date(now + 3600000).toISOString(),
            },
            {
              label: 'Weekly',
              windowMinutes: 10080,
              usedPercent: home === accounts.profile(a.id).home ? 90 : 20,
              resetsAt: new Date(now + 3600000).toISOString(),
            },
          ],
        },
      }));
    expect(accounts.nextUnused('default', ['default'], now)).toBeNull();
    await read(99);
    expect(accounts.nextUnused('default', ['default'], now)).toBeNull();
    // The CLI's own limit message is a second signal: a meter within 5% of its end is enough.
    expect(accounts.nextUnused('default', ['default'], now, true)?.id).toBe(a.id);
    await read(94);
    expect(accounts.nextUnused('default', ['default'], now, true)).toBeNull();
    // The meter shows 100% for 99.6% used; a strict zero never matched that.
    await read(99.6);
    expect(accounts.nextUnused('default', ['default'], now)?.id).toBe(a.id);
    await read(100);
    expect(accounts.nextUnused('default', ['default'], now)?.id).toBe(a.id);
    accounts.setAutoSwitchEligible(a.id, false);
    expect(accounts.nextUnused('default', ['default'], now)?.id).toBe(b.id);
    expect(accounts.nextUnused('default', ['default', b.id], now)).toBeNull();
    await read(100, 'unavailable');
    expect(accounts.nextUnused('default', ['default'], now)).toBeNull();
    await read(100, 'fresh', 120000);
    expect(accounts.nextUnused('default', ['default'], now)).toBeNull();
    await read(100);
    expect(accounts.nextUnused('default', ['default'], now + 3600001)).toBeNull();
  });

  it('breaks quota ties by weekly, then the saved order, and lets a reset account back in', async () => {
    writeFileSync(
      path.join(defaultCodexHome, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'current' }),
    );
    const accounts = new CodexAccounts(tmpDir, db);
    for (const name of ['A', 'B', 'C'])
      accounts.importAccount(name, JSON.stringify({ OPENAI_API_KEY: name }));
    const [a, b, c] = accounts.state().accounts;
    const now = Date.now();
    // Remaining [5-hour, weekly] per account; the default login is exhausted.
    const read = (left: Record<string, [number, number]>) =>
      accounts.refreshUsage(async (home) => {
        const id = [a!, b!, c!].find((x) => accounts.profile(x.id).home === home)?.id;
        const [fiveHour, weekly] = id ? left[id]! : [0, 50];
        return {
          status: 'fresh' as const,
          checkedAt: new Date(now).toISOString(),
          limits: {
            providerId: 'codex',
            source: 'test',
            asOf: new Date(now).toISOString(),
            windows: [
              {
                label: '5-hour',
                windowMinutes: 300,
                usedPercent: 100 - fiveHour,
                resetsAt: new Date(now + 3600000).toISOString(),
              },
              {
                label: 'Weekly',
                windowMinutes: 10080,
                usedPercent: 100 - weekly,
                resetsAt: new Date(now + 86400000).toISOString(),
              },
            ],
          },
        };
      });
    await read({ [a!.id]: [40, 60], [b!.id]: [40, 90], [c!.id]: [100, 5] });
    expect(accounts.nextUnused('default', ['default'], now)?.id).toBe(c!.id);
    await read({ [a!.id]: [40, 60], [b!.id]: [40, 90], [c!.id]: [40, 5] });
    expect(accounts.nextUnused('default', ['default'], now)?.id).toBe(b!.id);
    await read({ [a!.id]: [40, 60], [b!.id]: [40.3, 59.8], [c!.id]: [0, 100] });
    expect(accounts.nextUnused('default', ['default'], now)?.id).toBe(a!.id);
    accounts.setOrder([c!.id, b!.id, a!.id]);
    expect(accounts.state().accounts.map((x) => x.id)).toEqual([c!.id, b!.id, a!.id]);
    expect(accounts.nextUnused('default', ['default'], now)?.id).toBe(b!.id);
    // A tried account is back only once a reading taken after it was left shows quota.
    expect(accounts.quotaRecovered(c!.id, now - 1, now)).toBe(false);
    expect(accounts.quotaRecovered(a!.id, now, now)).toBe(false);
    expect(accounts.quotaRecovered(a!.id, now - 1, now)).toBe(true);
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
