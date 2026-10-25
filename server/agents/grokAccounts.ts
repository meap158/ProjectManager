import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { NativeAccount, NativeAccountsState } from '../../shared/nativeAccounts.js';
import type { ProviderLimits } from '../../shared/limits.js';

const MAX_AUTH = 64 * 1024;
const MAX_AGE = 60_000;
export class GrokAccountError extends Error {
  readonly status = 400;
}
const validId = z.string().regex(/^grok_[a-f0-9]{32}$/);
const entrySchema = z
  .object({
    key: z.string().min(1).max(MAX_AUTH),
    email: z.string().email().max(320),
    user_id: z.string().optional(),
    principal_id: z.string().optional(),
    team_id: z.string().optional(),
    expires_at: z.string().optional(),
    auth_mode: z.string().optional(),
  })
  .passthrough();

/** Matches Grok Build OIDC issuer entries; JWT fields are display metadata, not authentication. */
export function parseGrokAuth(raw: string) {
  if (Buffer.byteLength(raw) > MAX_AUTH)
    throw new GrokAccountError('Grok credential file exceeds 64 KiB.');
  let input: Record<string, unknown>;
  try {
    input = z.record(z.string(), z.unknown()).parse(JSON.parse(raw));
  } catch {
    throw new GrokAccountError('Invalid Grok credential JSON.');
  }
  for (const origin of ['https://auth.x.ai', 'https://accounts.x.ai'])
    for (const [issuer, value] of Object.entries(input)) {
      let parsed: URL;
      try {
        // Grok 1.0.62 namespaces its issuer key by account: <issuer>::<account-id>.
        const parts = issuer.split('::');
        if (parts.length > 2 || (parts.length === 2 && !/^[A-Za-z0-9_-]+$/.test(parts[1]!)))
          continue;
        parsed = new URL(parts[0]!);
      } catch {
        continue;
      }
      if (parsed.origin !== origin || parsed.username || parsed.password) continue;
      const entry = entrySchema.safeParse(value);
      if (!entry.success) continue;
      const e = entry.data;
      if (e.auth_mode && !/oauth|oidc/i.test(e.auth_mode)) continue;
      let claims: Record<string, unknown> = {};
      try {
        claims = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(Buffer.from(e.key.split('.')[1] ?? '', 'base64url').toString()));
      } catch {
        /* Opaque access tokens are supported. */
      }
      const principal =
        e.user_id ||
        e.principal_id ||
        (typeof claims.principal_id === 'string' ? claims.principal_id : '') ||
        (typeof claims.sub === 'string' ? claims.sub : '');
      const team = e.team_id || (typeof claims.team_id === 'string' ? claims.team_id : '');
      const email = e.email.trim().toLowerCase();
      const id =
        'grok_' +
        createHash('sha256')
          .update(JSON.stringify([origin, principal || email, team]))
          .digest('hex')
          .slice(0, 32);
      const expiry =
        e.expires_at ||
        (typeof claims.exp === 'number' &&
        Number.isFinite(claims.exp) &&
        Math.abs(claims.exp) < 8e12
          ? new Date(claims.exp * 1000).toISOString()
          : null);
      return {
        id,
        email,
        token: e.key,
        expiry,
        raw,
        fingerprint: createHash('sha256').update(raw).digest('hex'),
      };
    }
  throw new GrokAccountError(
    'No supported Grok OIDC login found. Sign in with grok login or import its auth.json.',
  );
}

const windowSchema = z.object({
  label: z.string().max(80),
  windowMinutes: z.number().nonnegative(),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.string().nullable(),
});
const rowSchema = z.object({
  id: validId,
  name: z.string().max(160),
  email: z.string().email(),
  active: z.boolean(),
  plan: z.string().max(160).nullable(),
  usage: z.object({
    fiveHour: z.number().nullable(),
    weekly: z.number().nullable(),
    updatedAt: z.string().nullable(),
  }),
  limits: z
    .object({
      providerId: z.literal('grok'),
      source: z.string(),
      asOf: z.string(),
      windows: z.array(windowSchema),
    })
    .nullable()
    .optional(),
  usageStatus: z.enum(['fresh', 'stale', 'expired', 'unavailable', 'not_loaded']).optional(),
});
const emptyUsage = () => ({ fiveHour: null, weekly: null, updatedAt: null });
export function grokHome(home = os.homedir(), env: NodeJS.ProcessEnv = process.env) {
  const configured = env.GROK_HOME || env.GROK_CONFIG_DIR;
  return configured
    ? path.resolve(configured.replace(/^~(?=$|[/\\])/, home))
    : path.join(home, '.grok');
}
export class GrokAccounts {
  private readonly root: string;
  private readonly authFile: string;
  private busy = false;
  private lastRefresh = 0;
  private quota = new Map<string, { fingerprint: string; account: NativeAccount }>();
  constructor(
    dataDir: string,
    home = grokHome(),
    private readonly request: typeof fetch = fetch,
  ) {
    this.root = path.join(dataDir, 'grok-accounts');
    this.authFile = path.join(home, 'auth.json');
  }
  private read(file: string) {
    if (statSync(file).size > MAX_AUTH)
      throw new GrokAccountError('Grok credential file exceeds 64 KiB.');
    return readFileSync(file, 'utf8');
  }
  private current() {
    return existsSync(this.authFile) ? parseGrokAuth(this.read(this.authFile)) : null;
  }
  private atomic(file: string, data: string | Buffer) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
      writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  private key() {
    const file = path.join(this.root, 'encryption.key');
    if (!existsSync(file)) {
      if (existsSync(this.root) && readdirSync(this.root).some((x) => x.endsWith('.enc')))
        throw new GrokAccountError('Grok encryption key is missing. Restore it from backup.');
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    const key = readFileSync(file);
    if (key.length !== 32)
      throw new GrokAccountError('Invalid Grok encryption key. Restore it from backup.');
    return key;
  }
  private snapshot(raw: string, name?: string) {
    const auth = parseGrokAuth(raw);
    const rows = this.rows();
    const previous = rows.find((a) => a.id === auth.id);
    if (!previous && rows.length >= 200)
      throw new GrokAccountError('At most 200 Grok accounts can be saved.');
    if (name !== undefined && name.trim().length > 160)
      throw new GrokAccountError('Account name exceeds 160 characters.');
    this.writeEncrypted(path.join(this.root, auth.id + '.enc'), raw);
    const row: NativeAccount = {
      id: auth.id,
      email: auth.email,
      name: name?.trim() || previous?.name || auth.email,
      active: false,
      plan: null,
      usage: emptyUsage(),
      usageStatus: 'not_loaded',
      limits: null,
    };
    this.saveRows([...rows.filter((a) => a.id !== row.id), row]);
    return row;
  }
  private writeEncrypted(file: string, raw: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const bytes = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
    this.atomic(file, Buffer.concat([iv, cipher.getAuthTag(), bytes]));
  }
  private decrypt(id: string) {
    validId.parse(id);
    const file = path.join(this.root, id + '.enc');
    if (!existsSync(file) || !existsSync(path.join(this.root, 'encryption.key')))
      throw new GrokAccountError('Saved Grok credential or encryption key is missing.');
    const bytes = readFileSync(file);
    if (bytes.length < 28 || bytes.length > MAX_AUTH + 28)
      throw new GrokAccountError('Invalid saved Grok credential.');
    const cipher = createDecipheriv('aes-256-gcm', this.key(), bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const raw = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
    if (parseGrokAuth(raw).id !== id)
      throw new GrokAccountError('Saved Grok credential identity mismatch.');
    return raw;
  }
  private rows() {
    const file = path.join(this.root, 'registry.json');
    return existsSync(file)
      ? z
          .array(rowSchema)
          .max(200)
          .parse(JSON.parse(readFileSync(file, 'utf8')))
      : [];
  }
  private saveRows(rows: NativeAccount[]) {
    this.atomic(path.join(this.root, 'registry.json'), JSON.stringify(rows));
  }
  private account(auth: ReturnType<typeof parseGrokAuth>, saved?: NativeAccount): NativeAccount {
    const cached = this.quota.get(auth.id);
    const valid = cached?.fingerprint === auth.fingerprint ? cached.account : null;
    const expired =
      auth.expiry !== null &&
      (!Number.isFinite(Date.parse(auth.expiry)) || Date.parse(auth.expiry) <= Date.now());
    return {
      id: auth.id,
      name: saved?.name || auth.email,
      email: auth.email,
      active: false,
      plan: valid?.plan ?? null,
      usage: expired ? emptyUsage() : (valid?.usage ?? emptyUsage()),
      limits: expired ? null : (valid?.limits ?? null),
      usageStatus: expired
        ? 'expired'
        : valid?.usageStatus === 'fresh' &&
            Date.now() - Date.parse(valid.usage.updatedAt ?? '') > MAX_AGE
          ? 'stale'
          : (valid?.usageStatus ?? 'not_loaded'),
    };
  }
  state(refreshStale = false): NativeAccountsState {
    const current = this.current();
    const rows = this.rows();
    const accounts = rows.map((row) => {
      try {
        const auth = current?.id === row.id ? current : parseGrokAuth(this.decrypt(row.id));
        return { ...this.account(auth, row), active: auth.id === current?.id };
      } catch {
        return {
          ...row,
          active: false,
          usage: emptyUsage(),
          limits: null,
          usageStatus: 'unavailable' as const,
        };
      }
    });
    const defaultAccount = current
      ? {
          ...this.account(
            current,
            rows.find((a) => a.id === current.id),
          ),
          active: true,
        }
      : null;
    if (refreshStale && !this.busy && Date.now() - this.lastRefresh >= MAX_AGE)
      void this.refresh().catch(() => undefined);
    return { available: true, accounts, defaultAccount };
  }
  private async exclusive(fn: () => NativeAccountsState | Promise<NativeAccountsState>) {
    if (this.busy) throw new GrokAccountError('A Grok account operation is already running.');
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
  saveCurrent(name?: string) {
    return this.exclusive(() => {
      const auth = this.current();
      if (!auth) throw new GrokAccountError('Sign in with grok login first.');
      this.snapshot(auth.raw, name);
      return this.state();
    });
  }
  import(raw: string, name?: string) {
    return this.exclusive(() => {
      this.snapshot(raw, name);
      return this.state();
    });
  }
  rename(id: string, name: string) {
    return this.exclusive(() => {
      validId.parse(id);
      const rows = this.rows(),
        row = rows.find((a) => a.id === id);
      if (!row) throw new GrokAccountError('Grok account not found.');
      row.name = z.string().trim().min(1).max(160).parse(name);
      this.saveRows(rows);
      return this.state();
    });
  }
  remove(id: string) {
    return this.exclusive(() => {
      validId.parse(id);
      const rows = this.rows();
      if (!rows.some((a) => a.id === id)) throw new GrokAccountError('Grok account not found.');
      this.saveRows(rows.filter((a) => a.id !== id));
      rmSync(path.join(this.root, id + '.enc'), { force: true });
      this.quota.delete(id);
      return this.state();
    });
  }
  switch(id: string) {
    return this.exclusive(() => {
      validId.parse(id);
      const raw = this.decrypt(id),
        current = this.current();
      if (current?.id === id) return this.state();
      // Re-capture the CLI's refreshed token before replacing it. No logout/revocation.
      if (current) {
        this.snapshot(current.raw);
        this.writeEncrypted(path.join(this.root, 'previous.enc'), current.raw);
      }
      // A concurrent external grok login must never be overwritten silently.
      if (this.current()?.fingerprint !== current?.fingerprint)
        throw new GrokAccountError('Grok login changed. Refresh accounts before switching.');
      try {
        this.atomic(this.authFile, raw);
        if (this.current()?.fingerprint !== parseGrokAuth(raw).fingerprint)
          throw new GrokAccountError('Verification failed.');
      } catch {
        if (current) this.atomic(this.authFile, current.raw);
        else rmSync(this.authFile, { force: true });
        throw new GrokAccountError('Grok account switch failed; previous login restored.');
      }
      this.lastRefresh = 0;
      return this.state();
    });
  }
  private async json(url: string, token: string) {
    const response = await this.request(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: {
        Authorization: 'Bearer ' + token,
        'x-xai-token-auth': 'xai-grok-cli',
        Accept: 'application/json',
        'User-Agent': 'ProjectManager',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GrokAccountError(response.status === 401 ? 'expired' : 'unavailable');
    }
    if (!response.body) throw new GrokAccountError('unavailable');
    const reader = response.body.getReader();
    const parts: Buffer[] = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 1024 * 1024) throw new GrokAccountError('unavailable');
        parts.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(parts).toString()) as unknown;
  }
  async refresh(onlyId?: string) {
    return this.exclusive(async () => {
      if (onlyId && onlyId !== 'default') validId.parse(onlyId);
      const current = this.current();
      const rows = this.rows();
      if (onlyId && onlyId !== 'default' && !rows.some((a) => a.id === onlyId))
        throw new GrokAccountError('Grok account not found.');
      const targets = new Map<string, ReturnType<typeof parseGrokAuth>>();
      if (current && (!onlyId || onlyId === 'default' || onlyId === current.id))
        targets.set(current.id, current);
      if (onlyId !== 'default')
        for (const row of rows)
          if (!onlyId || onlyId === row.id) {
            if (targets.has(row.id)) continue;
            try {
              targets.set(row.id, parseGrokAuth(this.decrypt(row.id)));
            } catch {
              this.quota.delete(row.id);
            }
          }
      for (const auth of targets.values()) {
        const account = this.account(
          auth,
          rows.find((a) => a.id === auth.id),
        );
        account.usage = emptyUsage();
        account.limits = null;
        account.usageStatus = 'unavailable';
        try {
          if (
            auth.expiry &&
            (!Number.isFinite(Date.parse(auth.expiry)) || Date.parse(auth.expiry) <= Date.now())
          )
            throw new GrokAccountError('expired');
          const billing = z
            .object({
              config: z.object({
                creditUsagePercent: z.number().finite().min(0).max(100),
                currentPeriod: z
                  .object({ type: z.string().optional(), end: z.string().optional() })
                  .optional(),
                billingPeriodEnd: z.string().optional(),
              }),
            })
            .parse(
              await this.json(
                'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
                auth.token,
              ),
            );
          const asOf = new Date().toISOString();
          const period = billing.config.currentPeriod?.type ?? '';
          const labels: Record<string, string> = {
            USAGE_PERIOD_TYPE_WEEKLY: 'Weekly',
            USAGE_PERIOD_TYPE_MONTHLY: 'Monthly',
            USAGE_PERIOD_TYPE_DAILY: 'Daily',
          };
          const reset = billing.config.currentPeriod?.end ?? billing.config.billingPeriodEnd;
          const minutes =
            period === 'USAGE_PERIOD_TYPE_WEEKLY'
              ? 10080
              : period === 'USAGE_PERIOD_TYPE_DAILY'
                ? 1440
                : 0;
          account.limits = {
            providerId: 'grok',
            source: 'Grok billing service',
            asOf,
            windows: [
              {
                label: labels[period] ?? 'Credits',
                windowMinutes: minutes,
                usedPercent: billing.config.creditUsagePercent,
                resetsAt:
                  reset && Number.isFinite(Date.parse(reset))
                    ? new Date(reset).toISOString()
                    : null,
              },
            ],
          } satisfies ProviderLimits;
          account.usage = {
            fiveHour: null,
            weekly:
              period === 'USAGE_PERIOD_TYPE_WEEKLY' ? billing.config.creditUsagePercent : null,
            updatedAt: asOf,
          };
          account.usageStatus = 'fresh';
          try {
            const settings = z
              .object({ subscription_tier_display: z.string().max(160) })
              .parse(await this.json('https://cli-chat-proxy.grok.com/v1/settings', auth.token));
            account.plan = settings.subscription_tier_display;
          } catch {
            /* Billing remains valid when optional plan metadata is unavailable. */
          }
        } catch (error) {
          account.usageStatus =
            error instanceof Error && error.message === 'expired' ? 'expired' : 'unavailable';
        }
        // External changes to this credential invalidate a pending response.
        const latest = this.current();
        if (current?.id === auth.id && latest?.fingerprint !== auth.fingerprint) continue;
        this.quota.set(auth.id, { fingerprint: auth.fingerprint, account });
      }
      if (!onlyId) this.lastRefresh = Date.now();
      return this.state();
    });
  }
}
