import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db.js';
import { CodexAccounts } from './codexAccounts.js';

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

    // Copy a rollout file from default home to Acc 2 so `codex resume` keeps conversation history.
    const rolloutRel = path.join('sessions', '2026', '10', '17', 'rollout-conv-123.jsonl');
    const srcRollout = path.join(defaultCodexHome, rolloutRel);
    mkdirSync(path.dirname(srcRollout), { recursive: true });
    writeFileSync(srcRollout, '{"id":"conv-123"}\n', 'utf8');
    writeFileSync(path.join(defaultCodexHome, 'session_index.jsonl'), '{"id":"conv-123"}\n', 'utf8');

    accounts.copyRolloutToHome(defaultCodexHome, accounts.profile(id2).home, srcRollout);
    expect(
      readFileSync(path.join(accounts.profile(id2).home, rolloutRel), 'utf8'),
    ).toBe('{"id":"conv-123"}\n');
    expect(
      readFileSync(path.join(accounts.profile(id2).home, 'session_index.jsonl'), 'utf8'),
    ).toBe('{"id":"conv-123"}\n');
  });
});
