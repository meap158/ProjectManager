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
it('accepts account-namespaced issuer keys without weakening trusted issuer checks', () => {
  const canonical = parseGrokAuth(auth('a@example.com'));
  const namespaced = parseGrokAuth(
    auth('a@example.com', 'access-a@example.com', 'team-a', 'https://auth.x.ai::account-123'),
  );
  expect(namespaced.id).toBe(canonical.id);
  expect(namespaced.email).toBe(canonical.email);
  for (const issuer of [
    'https://auth.x.ai.evil.test::account-123',
    'https://auth.x.ai::',
    'https://auth.x.ai::account::extra',
  ])
    expect(() => parseGrokAuth(auth('a@example.com', 'token', 'team', issuer))).toThrow(
      'supported',
    );
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
it('keeps a login left out of automatic switching out across re-saves (PM-531)', async () => {
  const { service, file } = setup();
  writeFileSync(file, auth('a@example.com'));
  const b = (await service.import(auth('b@example.com'))).accounts[0]!;
  expect(b.autoSwitchEligible).toBeUndefined();
  const out = await service.setAutoSwitchEligible(b.id, false);
  expect(out.accounts[0]?.autoSwitchEligible).toBe(false);
  // A newer copy of the same login (renewed tokens) keeps the choice.
  await service.import(auth('b@example.com', 'renewed-token'));
  expect(service.state().accounts[0]?.autoSwitchEligible).toBe(false);
  await service.setAutoSwitchEligible(b.id, true);
  expect(service.state().accounts[0]?.autoSwitchEligible).toBeUndefined();
  await expect(service.setAutoSwitchEligible('grok_' + 'f'.repeat(32), false)).rejects.toThrow(
    'not found',
  );
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
it('reads a billing reply with no credit percentage as no allowance, not unavailable (PM-525)', async () => {
  // The reply Grok gives an account with no subscription or prepaid credits.
  const reply = {
    config: {
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2099-01-01T00:00:00Z' },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      prepaidBalance: { val: 0 },
      isUnifiedBillingUser: true,
    },
  };
  const request = vi.fn(
    async (url: string | URL | Request) =>
      new Response(JSON.stringify(String(url).includes('/billing') ? reply : { tips: [] })),
  );
  const { service, file } = setup(request as typeof fetch);
  writeFileSync(file, auth('free@example.com'));
  const account = (await service.refresh()).defaultAccount!;
  expect(account.usageStatus).toBe('fresh');
  expect(account.limits).toBeNull();
  expect(account.usageNote).toContain('no credit allowance');
  // An on-demand cap is measured instead.
  reply.config.onDemandCap.val = 40;
  reply.config.onDemandUsed.val = 10;
  const capped = (await service.refresh()).defaultAccount!;
  expect(capped.limits?.windows[0]).toMatchObject({ label: 'On-demand', usedPercent: 25 });
  expect(capped.usageNote).toBeUndefined();
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
it('keeps the active saved login current as the CLI renews it, so a later login elsewhere loses nothing (PM-523)', async () => {
  const { file, service } = setup();
  writeFileSync(file, auth('b@example.com'));
  await service.saveCurrent();
  writeFileSync(file, auth('a@example.com', 'access-a-1'));
  await service.saveCurrent();
  const order = service.state().accounts.map((a) => a.email);
  // The CLI renews account a's tokens while it is in use.
  writeFileSync(file, auth('a@example.com', 'access-a-2'));
  service.state();
  // Then the owner signs in to account b with the CLI: a's newest tokens were already saved.
  writeFileSync(file, auth('b@example.com'));
  const a = service.state().accounts.find((x) => x.email === 'a@example.com')!;
  await service.switch(a.id);
  expect(JSON.parse(readFileSync(file, 'utf8'))['https://auth.x.ai'].key).toBe('access-a-2');
  // Re-saving keeps the owner's order.
  expect(service.state().accounts.map((x) => x.email)).toEqual(order);
});
it('marks an expired access token with a refresh token as renewable, not lost (PM-523)', async () => {
  const { file, service } = setup();
  writeFileSync(
    file,
    auth('a@example.com', 'old', 'team-a', 'https://auth.x.ai', '2020-01-01T00:00:00Z'),
  );
  const account = service.state().defaultAccount!;
  expect(account.usageStatus).toBe('expired');
  expect(account.renewable).toBe(true);
});
