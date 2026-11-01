import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openDb } from '../db.js';
import { ClaudeAccounts } from './codexAccounts.js';

it('switches isolated Claude profiles, preserves saved timestamps, and restores the default login', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pm-claude-profiles-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const home = path.join(temp, 'default');
  mkdirSync(home);
  process.env.CLAUDE_CONFIG_DIR = home;
  const db = openDb(':memory:');
  try {
    const original = JSON.stringify({
      claudeAiOauth: { accessToken: 'fake-default', refreshToken: 'fake-default-refresh' },
    });
    writeFileSync(path.join(home, '.credentials.json'), original);
    const pool = new ClaudeAccounts(temp, db);
    const added = pool.importAccount(
      'Saved Claude',
      JSON.stringify({
        claudeAiOauth: { accessToken: 'fake-saved', refreshToken: 'fake-saved-refresh' },
      }),
    );
    const account = added.accounts[0]!;
    expect(Number.isFinite(Date.parse(account.createdAt))).toBe(true);
    const selected = pool.setActive(account.id);
    expect(selected.activeProfileId).toBe(account.id);
    expect(selected.defaultAccount.available).toBe(true);
    expect(selected.originalAccount?.available).toBe(true);
    expect(
      JSON.parse(readFileSync(path.join(home, '.credentials.json'), 'utf8')).claudeAiOauth
        .accessToken,
    ).toBe('fake-saved');
    expect(pool.renameAccount(account.id, 'Work').accounts[0]?.createdAt).toBe(account.createdAt);
    expect(pool.state().accounts[0]?.usageStatus).toBe('not_loaded');
    const result = spawnSync(
      process.execPath,
      [
        'scripts/claude-statusline.mjs',
        temp,
        createHash('sha256').update('fake-saved').digest('hex'),
      ],
      {
        input: JSON.stringify({
          rate_limits: {
            five_hour: { used_percentage: 37, resets_at: Math.floor(Date.now() / 1000) + 3600 },
          },
        }),
        env: { ...process.env, CLAUDE_CONFIG_DIR: home },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
    const identity = createHash('sha256').update('fake-saved').digest('hex');
    expect(
      existsSync(path.join(temp, 'claude-account-usage', identity, 'claude-limits.json')),
    ).toBe(true);
    expect(pool.state().accounts[0]?.limits?.windows[0]?.usedPercent).toBe(37);
    expect(pool.state().accounts[0]?.usageStatus).toBe('fresh');
    expect(pool.state().defaultAccount.limits?.windows[0]?.usedPercent).toBe(37);
    expect(pool.state().originalAccount?.limits).toBeNull();
    expect(pool.setActive(null).activeProfileId).toBeNull();
    expect(readFileSync(path.join(home, '.credentials.json'), 'utf8')).toBe(original);
  } finally {
    db.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});

it('preserves refreshed tokens and restores an unsigned-in default without reviving stale credentials', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pm-claude-refresh-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const home = path.join(temp, 'default');
  mkdirSync(home);
  process.env.CLAUDE_CONFIG_DIR = home;
  const db = openDb(':memory:');
  const live = path.join(home, '.credentials.json');
  const auth = (token: string) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        refreshToken: (token === 'refreshed' ? 'first' : token) + '-refresh',
      },
    });
  try {
    const pool = new ClaudeAccounts(temp, db);
    const first = pool.importAccount('First', auth('first')).accounts[0]!.id;
    const second = pool.importAccount('Second', auth('second')).accounts[1]!.id;
    pool.setActive(first);
    expect(pool.state().defaultAccount.available).toBe(true);
    expect(pool.state().originalAccount?.available).toBe(false);
    writeFileSync(live, auth('refreshed'));
    pool.setActive(second);
    pool.setActive(first);
    expect(readFileSync(live, 'utf8')).toBe(auth('refreshed'));
    pool.setActive(null);
    expect(existsSync(live)).toBe(false);
    writeFileSync(live, auth('default'));
    pool.setActive(first);
    pool.setActive(null);
    expect(readFileSync(live, 'utf8')).toBe(auth('default'));
    rmSync(live);
    pool.setActive(first);
    pool.removeAccount(first);
    expect(readFileSync(live, 'utf8')).toBe(auth('refreshed'));
    rmSync(path.join(temp, 'claude-accounts', second, '.credentials.json'));
    expect(() => pool.setActive(second)).toThrow('credentials file is missing');
    expect(pool.state().activeProfileId).toBeNull();
  } finally {
    db.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});
it('does not attribute an external login to the previously selected profile or overwrite its credentials', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pm-claude-external-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const home = path.join(temp, 'default');
  mkdirSync(home);
  process.env.CLAUDE_CONFIG_DIR = home;
  const db = openDb(':memory:');
  const auth = (token: string) =>
    JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: token + '-refresh' } });
  const live = path.join(home, '.credentials.json');
  try {
    const pool = new ClaudeAccounts(temp, db);
    const a = pool.importAccount('A', auth('a')).accounts[0]!.id;
    const b = pool.importAccount('B', auth('b')).accounts[1]!.id;
    pool.setActive(a);
    writeFileSync(live, auth('external'));
    expect(pool.state().activeProfileId).toBeNull();
    pool.setActive(b);
    pool.setActive(a);
    expect(JSON.parse(readFileSync(live, 'utf8'))).toEqual(JSON.parse(auth('a')));
    pool.setActive(null);
    expect(readFileSync(live, 'utf8')).toBe(auth('external'));
  } finally {
    db.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});

it('keeps showing an account’s usage after Claude rotates its token (PM-366)', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pm-claude-rotated-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const home = path.join(temp, 'default');
  mkdirSync(home);
  process.env.CLAUDE_CONFIG_DIR = home;
  const db = openDb(':memory:');
  const report = (identity: string, used: number) =>
    spawnSync(process.execPath, ['scripts/claude-statusline.mjs', temp, identity], {
      input: JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: used, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        },
      }),
      env: { ...process.env, CLAUDE_CONFIG_DIR: home },
      encoding: 'utf8',
    });
  const hash = (token: string) => createHash('sha256').update(token).digest('hex');
  try {
    writeFileSync(
      path.join(home, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'fake-default', refreshToken: 'fake-dr' } }),
    );
    const pool = new ClaudeAccounts(temp, db);
    const other = pool.importAccount(
      'Other',
      JSON.stringify({ claudeAiOauth: { accessToken: 'fake-other', refreshToken: 'fake-or' } }),
    ).accounts[0]!;
    const work = pool
      .importAccount(
        'Work',
        JSON.stringify({ claudeAiOauth: { accessToken: 'fake-work-1', refreshToken: 'fake-wr' } }),
      )
      .accounts.find((a) => a.name === 'Work')!;
    pool.setActive(work.id);
    // A session starts on Work and is claimed for it; then Claude rotates the live token.
    pool.claimUsage(hash('fake-work-1'));
    writeFileSync(
      path.join(home, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'fake-work-2', refreshToken: 'fake-wr' } }),
    );
    expect(report(hash('fake-work-1'), 54).status).toBe(0);
    const state = pool.state();
    expect(state.activeProfileId).toBe(work.id);
    const shown = state.accounts.find((a) => a.id === work.id)!;
    expect(shown.limits?.windows[0]?.usedPercent).toBe(54);
    expect(shown.usageStatus).toBe('fresh');
    // The live default mirrors Work. Other accounts and the preserved original stay empty.
    expect(state.accounts.find((a) => a.id === other.id)?.limits).toBeNull();
    expect(state.defaultAccount.limits?.windows[0]?.usedPercent).toBe(54);
    expect(state.originalAccount?.limits).toBeNull();
  } finally {
    db.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});

// Claude's credentials name no account (no email): which one they are comes from its profile in
// .claude.json, trusted only when fetched after the credentials were last written.
const claudeCreds = (token: string, plan = 'pro') =>
  JSON.stringify({
    claudeAiOauth: { accessToken: token, refreshToken: `${token}-refresh`, subscriptionType: plan },
  });
const token = (file: string) =>
  (JSON.parse(readFileSync(file, 'utf8')) as { claudeAiOauth: { accessToken: string } })
    .claudeAiOauth.accessToken;
const claudeProfile = (home: string, email: string, fetchedAt: number) =>
  writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, profileFetchedAt: fetchedAt } }),
  );

it('treats the default login and a saved copy of it as one account after both tokens rotate', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pm-claude-same-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const home = path.join(temp, 'default');
  mkdirSync(home);
  process.env.CLAUDE_CONFIG_DIR = home;
  const db = openDb(':memory:');
  const live = path.join(home, '.credentials.json');
  const usage = (token: string, used: number, asOf: string) => {
    const folder = path.join(temp, 'claude-account-usage', hash(token));
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      path.join(folder, 'claude-limits.json'),
      JSON.stringify({
        asOf,
        fiveHour: { used_percentage: used, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        sevenDay: null,
      }),
    );
  };
  const hash = (token: string) => createHash('sha256').update(token).digest('hex');
  try {
    writeFileSync(live, claudeCreds('fake-1'));
    claudeProfile(home, 'me@example.com', Date.now() + 60_000);
    const pool = new ClaudeAccounts(temp, db);
    const copy = pool.saveCurrentAccount().accounts[0]!;
    expect(copy.email).toBe('me@example.com');
    pool.setActive(copy.id);
    // Claude refreshes: the access and refresh tokens both change, so no token matches the copy.
    writeFileSync(live, claudeCreds('fake-2'));
    pool.claimUsage(hash('fake-2'));
    usage('fake-2', 40, new Date().toISOString());
    let state = pool.state();
    expect(state.activeProfileId).toBe(copy.id);
    expect(state.accounts[0]?.limits?.windows[0]?.usedPercent).toBe(40);
    expect(state.defaultAccount.limits?.windows[0]?.usedPercent).toBe(40);

    // Back on the default login (the same account): the refreshed login stays, never the old
    // backup, and both entries show the newest report.
    pool.setActive(null);
    expect(token(live)).toBe('fake-2');
    pool.claimUsage(hash('fake-3'));
    usage('fake-3', 65, new Date(Date.now() + 1000).toISOString());
    state = pool.state();
    expect(state.activeProfileId).toBeNull();
    expect(state.defaultAccount.limits?.windows[0]?.usedPercent).toBe(65);
    expect(state.accounts[0]?.limits?.windows[0]?.usedPercent).toBe(65);

    // And onto the copy again: it takes the live login rather than restoring its older tokens.
    pool.setActive(copy.id);
    expect(token(live)).toBe('fake-2');
  } finally {
    db.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});

it('never takes a stale Claude profile as the live account', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pm-claude-stale-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const home = path.join(temp, 'default');
  mkdirSync(home);
  process.env.CLAUDE_CONFIG_DIR = home;
  const db = openDb(':memory:');
  const live = path.join(home, '.credentials.json');
  try {
    // The profile still names A, but was fetched before the live (other) login was written.
    claudeProfile(home, 'a@example.com', 0);
    writeFileSync(live, claudeCreds('other'));
    const pool = new ClaudeAccounts(temp, db);
    const a = pool.importAccount(
      'A',
      JSON.stringify({ email: 'a@example.com', ...JSON.parse(claudeCreds('a')) }),
    ).accounts[0]!;
    expect(a.email).toBe('a@example.com');
    expect(pool.state().accounts[0]?.limits).toBeNull();
    pool.setActive(a.id);
    expect(
      JSON.parse(
        readFileSync(path.join(temp, 'claude-accounts', a.id, '.credentials.json'), 'utf8'),
      ).claudeAiOauth.accessToken,
    ).toBe('a');
    expect(token(live)).toBe('a');
    pool.setActive(null);
    expect(JSON.parse(readFileSync(live, 'utf8')).claudeAiOauth.accessToken).toBe('other');
  } finally {
    db.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});

it('never credits one account’s usage to another that later takes the default slot (PM-395)', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pm-claude-slot-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const home = path.join(temp, 'default');
  mkdirSync(home);
  process.env.CLAUDE_CONFIG_DIR = home;
  const db = openDb(':memory:');
  const live = path.join(home, '.credentials.json');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const report = (value: string, used: number) => {
    const folder = path.join(temp, 'claude-account-usage', hash(value));
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      path.join(folder, 'claude-limits.json'),
      JSON.stringify({
        asOf: new Date().toISOString(),
        fiveHour: { used_percentage: used, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        sevenDay: null,
      }),
    );
  };
  try {
    // A is the default login; its session is claimed and reports, then A's token rotates.
    writeFileSync(live, claudeCreds('a-1'));
    claudeProfile(home, 'a@example.com', Date.now() + 60_000);
    const pool = new ClaudeAccounts(temp, db);
    pool.claimUsage(hash('a-1'));
    report('a-1', 30);
    // The owner signs in as B on the default slot and saves it.
    writeFileSync(live, claudeCreds('b-1', 'max'));
    claudeProfile(home, 'b@example.com', Date.now() + 120_000);
    const b = pool.saveCurrentAccount().accounts[0]!;
    const state = pool.state();
    expect(state.defaultAccount.email).toBe('b@example.com');
    expect(state.defaultAccount.limits).toBeNull();
    expect(state.accounts.find((x) => x.id === b.id)?.limits).toBeNull();
  } finally {
    db.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});

it('queries usage for logins with a valid token and records it per login (PM-395)', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pm-claude-query-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const home = path.join(temp, 'default');
  mkdirSync(home);
  process.env.CLAUDE_CONFIG_DIR = home;
  const db = openDb(':memory:');
  const creds = (token: string, expiresAt: number) =>
    JSON.stringify({
      claudeAiOauth: { accessToken: token, refreshToken: `${token}-r`, expiresAt },
    });
  try {
    writeFileSync(path.join(home, '.credentials.json'), creds('live', Date.now() + 3_600_000));
    claudeProfile(home, 'live@example.com', Date.now() + 60_000);
    const pool = new ClaudeAccounts(temp, db);
    const fresh = pool.importAccount(
      'Fresh',
      JSON.stringify({
        email: 'fresh@example.com',
        ...JSON.parse(creds('fresh', Date.now() + 3_600_000)),
      }),
    ).accounts[0]!;
    const expired = pool
      .importAccount(
        'Expired',
        JSON.stringify({
          email: 'old@example.com',
          ...JSON.parse(creds('old', Date.now() - 1000)),
        }),
      )
      .accounts.find((a) => a.name === 'Expired')!;
    const asked: string[] = [];
    pool.usageFetcher = async (token) => {
      asked.push(token);
      const used = token === 'live' ? 12 : 34;
      return {
        fiveHour: {
          used_percentage: used,
          resets_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        sevenDay: null,
      };
    };
    await pool.refreshUsage();
    expect(asked.sort()).toEqual(['fresh', 'live']);
    const state = pool.state();
    expect(state.defaultAccount.limits?.windows[0]?.usedPercent).toBe(12);
    expect(state.accounts.find((a) => a.id === fresh.id)?.limits?.windows[0]?.usedPercent).toBe(34);
    expect(state.accounts.find((a) => a.id === expired.id)?.limits).toBeNull();
    // Throttled: a second call inside the window does not ask again.
    await pool.refreshUsage({ maxAgeMs: 60_000 });
    expect(asked).toHaveLength(2);
  } finally {
    db.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});

it('records a status line report under the login in use now, not the launch token (PM-395)', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pm-claude-report-'));
  const home = path.join(temp, 'default');
  mkdirSync(home);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  try {
    // The session started on A; the owner switched to B and Claude picked up the new file.
    writeFileSync(path.join(home, '.credentials.json'), claudeCreds('b-now'));
    const result = spawnSync(
      process.execPath,
      ['scripts/claude-statusline.mjs', temp, hash('a-launch')],
      {
        input: JSON.stringify({
          rate_limits: {
            five_hour: { used_percentage: 7, resets_at: Math.floor(Date.now() / 1000) + 3600 },
          },
        }),
        env: { ...process.env, CLAUDE_CONFIG_DIR: home },
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
    const root = path.join(temp, 'claude-account-usage');
    expect(existsSync(path.join(root, hash('b-now'), 'claude-limits.json'))).toBe(true);
    expect(existsSync(path.join(root, hash('a-launch')))).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
