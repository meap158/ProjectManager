import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { GrokAccounts, grokHome, parseGrokAuth } from './grokAccounts.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function auth(
  email: string,
  token = 'access-' + email,
  team = 'team-a',
  issuer = 'https://auth.x.ai',
  expiry = '2099-01-01T00:00:00Z',
) {
  return JSON.stringify({
    [issuer]: {
      email,
      key: token,
      user_id: email,
      team_id: team,
      auth_mode: 'oauth',
      expires_at: expiry,
      refresh_token: 'refresh-' + email,
    },
  });
}
function setup(request: typeof fetch = vi.fn() as unknown as typeof fetch) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-grok-accounts-'));
  dirs.push(dir);
  const home = path.join(dir, 'home');
  mkdirSync(home);
  const file = path.join(home, 'auth.json');
  const data = path.join(dir, 'data');
  return { dir, home, file, data, service: new GrokAccounts(data, home, request) };
}
it('uses GROK_HOME and GROK_CONFIG_DIR with explicit precedence', () => {
  expect(grokHome('/users/test', { GROK_HOME: '/grok-one', GROK_CONFIG_DIR: '/grok-two' })).toBe(
    path.resolve('/grok-one'),
  );
  expect(grokHome('/users/test', {})).toBe(path.join('/users/test', '.grok'));
});
it('parses only trusted issuer entries and separates teams while preserving identity over token rotation', () => {
  expect(parseGrokAuth(auth('a@example.com', 'new')).id).toBe(
    parseGrokAuth(auth('a@example.com', 'old')).id,
  );
  expect(parseGrokAuth(auth('a@example.com', 'token', 'team-b')).id).not.toBe(
    parseGrokAuth(auth('a@example.com')).id,
  );
  expect(() =>
    parseGrokAuth(auth('a@example.com', 'token', 'team', 'https://auth.x.ai.evil.test')),
  ).toThrow('supported');
  expect(() => parseGrokAuth('{"api_key":"secret"}')).toThrow('supported');
  expect(() => parseGrokAuth('broken')).toThrow('JSON');
  expect(() => parseGrokAuth('x'.repeat(65537))).toThrow('64 KiB');
});
it('detects default email without saving and encrypts imported profiles without activation', async () => {
  const { service, file, data } = setup();
  writeFileSync(file, auth('a@example.com'));
  expect(service.state().defaultAccount).toMatchObject({ email: 'a@example.com', active: true });
  expect(service.state().accounts).toEqual([]);
  const state = await service.import(auth('b@example.com'), 'Work');
  expect(state.defaultAccount?.email).toBe('a@example.com');
  expect(state.accounts[0]?.name).toBe('Work');
  const bytes = readFileSync(path.join(data, 'grok-accounts', state.accounts[0]!.id + '.enc'));
  expect(bytes.includes(Buffer.from('access-'))).toBe(false);
  expect(JSON.stringify(state)).not.toContain('refresh-');
});
it('recaptures refreshed leaving tokens before switch, preserves history/config and restores on switch back', async () => {
  const { service, file, home } = setup();
  const first = auth('a@example.com', 'old');
  writeFileSync(file, first);
  const a = (await service.saveCurrent()).accounts[0]!;
  const b = (await service.import(auth('b@example.com'))).accounts.find(
    (a) => a.email === 'b@example.com',
  )!;
  const fresh = auth('a@example.com', 'new');
  writeFileSync(file, fresh);
  writeFileSync(path.join(home, 'config.toml'), 'preserve');
  mkdirSync(path.join(home, 'sessions'));
  writeFileSync(path.join(home, 'sessions', 'test.json'), 'preserve');
  await service.switch(b.id);
  expect(parseGrokAuth(readFileSync(file, 'utf8')).email).toBe('b@example.com');
  await service.switch(a.id);
  expect(readFileSync(file, 'utf8')).toBe(fresh);
  expect(readFileSync(path.join(home, 'config.toml'), 'utf8')).toBe('preserve');
  expect(readFileSync(path.join(home, 'sessions', 'test.json'), 'utf8')).toBe('preserve');
});
it('does not overwrite a refreshed current login when switching to its saved row', async () => {
  const { service, file } = setup();
  writeFileSync(file, auth('a@example.com', 'old'));
  const a = (await service.saveCurrent()).accounts[0]!;
  const fresh = auth('a@example.com', 'new');
  writeFileSync(file, fresh);
  await service.switch(a.id);
  expect(readFileSync(file, 'utf8')).toBe(fresh);
});
it('rename/remove leaves default credentials intact and rejects traversal/missing keys', async () => {
  const { service, file, data } = setup();
  const live = auth('a@example.com');
  writeFileSync(file, live);
  const b = (await service.import(auth('b@example.com'))).accounts[0]!;
  expect((await service.rename(b.id, 'Work')).accounts[0]?.name).toBe('Work');
  await expect(service.switch('../auth')).rejects.toThrow();
  rmSync(path.join(data, 'grok-accounts', 'encryption.key'));
  await expect(service.switch(b.id)).rejects.toThrow('missing');
  await expect(service.import(auth('c@example.com'))).rejects.toThrow('missing');
  await service.remove(b.id);
  expect(readFileSync(file, 'utf8')).toBe(live);
  expect(service.state().accounts).toEqual([]);
});
function billing(used: number) {
  return {
    config: {
      creditUsagePercent: used,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2099-01-01T00:00:00Z' },
    },
  };
}
it('reads per-account bearer quota, shows billing period/reset, and does not mix default readings after external login', async () => {
  const request = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) =>
      new Response(
        JSON.stringify(
          String(url).includes('/billing')
            ? billing(
                (init?.headers as Record<string, string>).Authorization.includes('access-a')
                  ? 20
                  : 70,
              )
            : { subscription_tier_display: 'SuperGrok' },
        ),
      ),
  );
  const { service, file } = setup(request as typeof fetch);
  writeFileSync(file, auth('a@example.com'));
  await service.saveCurrent();
  const b = (await service.import(auth('b@example.com'))).accounts.find(
    (a) => a.email === 'b@example.com',
  )!;
  const state = await service.refresh();
  expect(state.defaultAccount?.limits?.windows[0]).toMatchObject({
    usedPercent: 20,
    label: 'Weekly',
    resetsAt: '2099-01-01T00:00:00.000Z',
  });
  expect(state.accounts.find((a) => a.id === b.id)?.limits?.windows[0]?.usedPercent).toBe(70);
  writeFileSync(file, auth('b@example.com'));
  expect(service.state().defaultAccount?.limits?.windows[0]?.usedPercent).toBe(70);
  expect(
    request.mock.calls.every(
      ([, init]) =>
        (init?.headers as Record<string, string>)['x-xai-token-auth'] === 'xai-grok-cli',
    ),
  ).toBe(true);
});
it('individual active-account refresh reads current token only once', async () => {
  const request = vi.fn(
    async (url: string | URL | Request) =>
      new Response(JSON.stringify(String(url).includes('/billing') ? billing(25) : {})),
  );
  const { service, file } = setup(request as typeof fetch);
  writeFileSync(file, auth('a@example.com'));
  const a = (await service.saveCurrent()).accounts[0]!;
  await service.import(auth('b@example.com'));
  await service.refresh(a.id);
  expect(request).toHaveBeenCalledTimes(2);
});
it.each([401, 500])(
  'reports failed HTTP %s without exposing response secrets or converting unknown usage to zero',
  async (code) => {
    const request = vi.fn(async () => new Response('Bearer do-not-leak', { status: code }));
    const { service, file } = setup(request as typeof fetch);
    writeFileSync(file, auth('a@example.com'));
    const state = await service.refresh();
    expect(state.defaultAccount?.limits).toBeNull();
    expect(state.defaultAccount?.usageStatus).toBe(code === 401 ? 'expired' : 'unavailable');
    expect(JSON.stringify(state)).not.toContain('do-not-leak');
  },
);
it('refuses expired tokens and malformed billing without displaying a fabricated meter', async () => {
  const request = vi.fn(async () => new Response(JSON.stringify({ config: {} })));
  const { service, file } = setup(request as typeof fetch);
  writeFileSync(
    file,
    auth('a@example.com', 'token', 'team', 'https://auth.x.ai', '2000-01-01T00:00:00Z'),
  );
  expect((await service.refresh()).defaultAccount?.usageStatus).toBe('expired');
  expect(request).not.toHaveBeenCalled();
  writeFileSync(file, auth('a@example.com'));
  expect((await service.refresh()).defaultAccount?.limits).toBeNull();
});
it('invalidates a pending billing read after external credential replacement and serializes mutations', async () => {
  let release!: (response: Response) => void;
  const request = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const { service, file } = setup(request as typeof fetch);
  writeFileSync(file, auth('a@example.com'));
  const pending = service.refresh();
  await expect(service.import(auth('b@example.com'))).rejects.toThrow('already running');
  writeFileSync(file, auth('b@example.com'));
  release(new Response(JSON.stringify(billing(99))));
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  release(new Response('{}'));
  const state = await pending;
  expect(state.defaultAccount?.email).toBe('b@example.com');
  expect(state.defaultAccount?.limits).toBeNull();
});
it('starts with unknown usage after restart rather than trusting stale persisted quota', async () => {
  const { service, data, home, file } = setup();
  writeFileSync(file, auth('a@example.com'));
  await service.saveCurrent();
  const restarted = new GrokAccounts(data, home);
  expect(restarted.state().defaultAccount?.usageStatus).toBe('not_loaded');
  expect(restarted.state().defaultAccount?.limits).toBeNull();
  expect(readdirSync(path.join(data, 'grok-accounts')).some((name) => name.endsWith('.tmp'))).toBe(
    false,
  );
});
