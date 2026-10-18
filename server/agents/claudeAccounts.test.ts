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
    expect(pool.setActive(account.id).activeProfileId).toBe(account.id);
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
    expect(pool.state().defaultAccount.limits).toBeNull();
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
  const auth = (token: string) => JSON.stringify({ claudeAiOauth: { accessToken: token } });
  try {
    const pool = new ClaudeAccounts(temp, db);
    const first = pool.importAccount('First', auth('first')).accounts[0]!.id;
    const second = pool.importAccount('Second', auth('second')).accounts[1]!.id;
    pool.setActive(first);
    expect(pool.state().defaultAccount.available).toBe(false);
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
    expect(existsSync(live)).toBe(false);
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
