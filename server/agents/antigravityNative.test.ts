import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeAntigravityAccounts } from './antigravityNative.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pm-agy-native-'));
  dirs.push(root);
  let live: string | null = null;
  const store = {
    read: vi.fn(async () => live),
    write: vi.fn(async (raw: string) => {
      live = raw;
    }),
  };
  const service = new NativeAntigravityAccounts(
    path.join(root, 'data'),
    path.join(root, 'home'),
    store,
  );
  return {
    root,
    store,
    service,
    setLive: (raw: string) => {
      live = raw;
    },
  };
}
const credential = (email: string) =>
  JSON.stringify({
    token: {
      access_token: 'access-' + email,
      refresh_token: 'refresh-' + email,
      expiry: '2099-01-01T00:00:00Z',
    },
    id_token:
      'x.' + Buffer.from(JSON.stringify({ email, sub: email })).toString('base64url') + '.x',
  });
it('saves/imports encrypted profiles and switches both stores while retaining previous login', async () => {
  const { root, store, service, setLive } = setup();
  const a = credential('a@example.com'),
    b = credential('b@example.com');
  setLive(a);
  await service.saveCurrent();
  const imported = await service.import(b);
  const id = imported.accounts.find((x) => x.email === 'b@example.com')!.id;
  expect(
    readFileSync(path.join(root, 'data', 'antigravity-accounts', id + '.enc')).includes(
      Buffer.from('refresh-'),
    ),
  ).toBe(false);
  const state = await service.switch(id);
  expect(store.write).toHaveBeenCalledWith(b);
  expect(
    readFileSync(
      path.join(root, 'home', '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
      'utf8',
    ),
  ).toBe(b);
  expect(state.accounts.find((x) => x.id === id)?.active).toBe(true);
  expect(existsSync(path.join(root, 'data', 'antigravity-accounts', 'previous.enc'))).toBe(true);
  expect(JSON.stringify(state)).not.toContain('access-');
});
it('does not replace the file mirror when keyring write fails', async () => {
  const { root, store, service, setLive } = setup();
  setLive(credential('a@example.com'));
  const state = await service.import(credential('b@example.com'));
  store.write.mockRejectedValueOnce(new Error('unavailable'));
  await expect(service.switch(state.accounts[0]!.id)).rejects.toThrow();
  expect(
    existsSync(path.join(root, 'home', '.gemini', 'antigravity-cli', 'antigravity-oauth-token')),
  ).toBe(false);
});
it('fails invalid imports without saving profiles', async () => {
  const { service } = setup();
  await expect(service.import('{"token":{}}')).rejects.toThrow();
  expect((await service.state()).accounts).toEqual([]);
});
it('auto-detects default email without creating a saved profile', async () => {
  const { service, setLive } = setup();
  setLive(credential('default@example.com'));
  const state = await service.state();
  expect(state.defaultAccount).toMatchObject({ email: 'default@example.com', active: true });
  expect(state.accounts).toEqual([]);
});
it('reads id_token_email and repairs previously saved blank metadata without changing identity or nicknames', async () => {
  const { service, setLive } = setup();
  const doc = JSON.parse(credential('default@example.com'));
  delete doc.id_token;
  setLive(JSON.stringify(doc));
  const before = await service.saveCurrent();
  const id = before.defaultAccount!.id;
  doc.id_token_email = 'default@example.com';
  setLive(JSON.stringify(doc));
  const after = await service.state();
  expect(after.defaultAccount).toMatchObject({ id, email: 'default@example.com', active: true });
  expect(after.accounts[0]).toMatchObject({
    id,
    email: 'default@example.com',
    name: 'default@example.com',
  });
  await service.rename(id, 'Work');
  expect((await service.state()).defaultAccount?.name).toBe('Work');
});
it('uses current credential email when the saved matching row has missing metadata', async () => {
  const { service, setLive, root } = setup();
  const raw = credential('current@example.com');
  setLive(raw);
  await service.saveCurrent();
  const file = path.join(root, 'data', 'antigravity-accounts', 'registry.json');
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  rows[0].email = '';
  writeFileSync(file, JSON.stringify(rows));
  const state = await service.state();
  expect(state.defaultAccount?.email).toBe('current@example.com');
  expect(state.accounts[0]?.email).toBe('current@example.com');
});
it('renames and removes saved profiles without changing the default login', async () => {
  const { service, setLive, store } = setup();
  setLive(credential('default@example.com'));
  const saved = await service.import(credential('saved@example.com'));
  const id = saved.accounts[0]!.id;
  expect((await service.rename(id, 'Work')).accounts[0]?.name).toBe('Work');
  const result = await service.remove(id);
  expect(result.accounts).toEqual([]);
  expect(result.defaultAccount?.email).toBe('default@example.com');
  expect(store.write).not.toHaveBeenCalled();
});
it('rolls back a switch when keyring verification returns different credentials', async () => {
  const { root, store, service, setLive } = setup();
  const a = credential('a@example.com'),
    b = credential('b@example.com');
  setLive(a);
  const imported = await service.import(b);
  store.read.mockResolvedValueOnce(a).mockResolvedValueOnce(a);
  await expect(service.switch(imported.accounts[0]!.id)).rejects.toThrow(
    'previous login preserved',
  );
  expect(await store.read()).toBe(a);
  expect(
    existsSync(path.join(root, 'home', '.gemini', 'antigravity-cli', 'antigravity-oauth-token')),
  ).toBe(false);
});
it('refuses replacing a lost encryption key when saved profiles exist', async () => {
  const { root, service } = setup();
  await service.import(credential('a@example.com'));
  rmSync(path.join(root, 'data', 'antigravity-accounts', 'encryption.key'));
  await expect(service.import(credential('b@example.com'))).rejects.toThrow(
    'encryption key is missing',
  );
});
it('uses the selected credential token for quota and preserves missing quota as unavailable', async () => {
  const { root, store } = setup();
  const request = vi.fn(
    async (url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify(
          String(url).endsWith(':loadCodeAssist')
            ? { paidTier: { name: 'Pro' } }
            : {
                groups: [
                  {
                    buckets: [
                      { window: '5h', remainingFraction: 0.75, resetTime: '2099-01-01T00:00:00Z' },
                    ],
                  },
                ],
              },
        ),
        { status: 200 },
      ),
  );
  const service = new NativeAntigravityAccounts(
    path.join(root, 'data'),
    path.join(root, 'home'),
    store,
    request as typeof fetch,
  );
  await service.import(credential('a@example.com'));
  const result = await service.refresh();
  expect(result.accounts[0]?.usage).toMatchObject({ fiveHour: 25, weekly: null });
  expect(result.accounts[0]?.limits?.windows[0]).toMatchObject({
    usedPercent: 25,
    resetsAt: '2099-01-01T00:00:00.000Z',
  });
  expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
    Authorization: 'Bearer access-a@example.com',
  });
});
it('never replaces the live refreshed credential when selecting its already-active saved account', async () => {
  const { service, store, setLive } = setup();
  const initial = credential('a@example.com');
  setLive(initial);
  const saved = await service.saveCurrent();
  const changed = JSON.parse(initial);
  changed.token.access_token = 'fresh-access';
  setLive(JSON.stringify(changed));
  await service.switch(saved.accounts[0]!.id);
  expect(store.write).not.toHaveBeenCalled();
});
it('keeps an external login authoritative during an in-flight quota read and rejects concurrent mutations', async () => {
  const { root, store, setLive } = setup();
  setLive(credential('a@example.com'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = vi.fn(async (url: string | URL | Request) => {
    await gate;
    return new Response(
      JSON.stringify(
        String(url).endsWith(':loadCodeAssist')
          ? { paidTier: { name: 'Pro' } }
          : { groups: [{ buckets: [{ window: '5h', remainingFraction: 0 }] }] },
      ),
    );
  });
  const service = new NativeAntigravityAccounts(
    path.join(root, 'data'),
    path.join(root, 'home'),
    store,
    request as typeof fetch,
  );
  const saved = await service.saveCurrent();
  const pending = service.refresh();
  await vi.waitFor(() => expect(request).toHaveBeenCalled());
  await expect(service.remove(saved.accounts[0]!.id)).rejects.toThrow('already running');
  setLive(credential('b@example.com'));
  release();
  const state = await pending;
  expect(state.defaultAccount?.email).toBe('b@example.com');
  expect(state.defaultAccount?.usage.fiveHour).toBeNull();
  expect(state.accounts[0]?.active).toBe(false);
  expect(store.write).not.toHaveBeenCalled();
});
it('invalidates cached quota on credential changes and does not resurrect disk usage after restart', async () => {
  const { root, store, setLive } = setup();
  const raw = credential('a@example.com');
  setLive(raw);
  const request = vi.fn(
    async (url: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(url).endsWith(':loadCodeAssist')
            ? { paidTier: { name: 'Pro' } }
            : { groups: [{ buckets: [{ window: '5h', remainingFraction: 0.2 }] }] },
        ),
      ),
  );
  const create = () =>
    new NativeAntigravityAccounts(
      path.join(root, 'data'),
      path.join(root, 'home'),
      store,
      request as typeof fetch,
    );
  const service = create();
  await service.saveCurrent();
  expect((await service.refresh()).defaultAccount?.usage.fiveHour).toBe(80);
  const updated = JSON.parse(raw);
  updated.token.access_token = 'new-token';
  setLive(JSON.stringify(updated));
  expect((await service.state()).defaultAccount?.usage.fiveHour).toBeNull();
  expect((await create().state()).accounts[0]?.usage.fiveHour).toBeNull();
});
