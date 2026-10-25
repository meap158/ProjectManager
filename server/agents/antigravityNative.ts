import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { usageIsFresh } from './accountPolicy.js';
import type { UsageWindow } from '../../shared/limits.js';
import type {
  AntigravityAccount,
  AntigravityAccountsState,
} from '../../shared/antigravityAccounts.js';

const credentialSchema = z
  .object({
    token: z
      .object({
        access_token: z.string().optional(),
        refresh_token: z.string().optional(),
        expiry: z.string().optional(),
      })
      .passthrough(),
    id_token: z.string().optional(),
    id_token_email: z.string().max(320).optional(),
  })
  .passthrough()
  .refine((c) => c.token.access_token || c.token.refresh_token);
export function parseAgyCredential(raw: string) {
  if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('Credential file is too large.');
  return credentialSchema.parse(JSON.parse(raw));
}
function identity(raw: string) {
  const c = parseAgyCredential(raw);
  let claims: { sub?: string; email?: string } = {};
  try {
    claims = JSON.parse(Buffer.from(c.id_token?.split('.')[1] ?? '', 'base64url').toString());
  } catch {
    /* Metadata may be absent. */
  }
  const key =
    typeof claims.sub === 'string' ? claims.sub : c.token.refresh_token || c.token.access_token!;
  return {
    id: 'acct_' + createHash('sha256').update(key).digest('hex').slice(0, 24),
    email: z.string().email().safeParse(c.id_token_email).success
      ? c.id_token_email!
      : typeof claims.email === 'string'
        ? claims.email
        : '',
  };
}
export interface AgyStore {
  read(): Promise<string | null>;
  write(raw: string): Promise<void>;
  rollbackEmpty?(): Promise<void>;
}
async function credentialBridge(
  operation: 'read' | 'write' | 'rollback-empty',
  raw?: string,
): Promise<string | null> {
  if (process.platform !== 'win32')
    throw new Error('Native Antigravity credential switching currently requires Windows.');
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        path.resolve('scripts/antigravity-credential.ps1'),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let output = '';
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else {
        try {
          resolve((JSON.parse(output) as { raw?: string }).raw ?? null);
        } catch {
          reject(new Error('Invalid credential store response.'));
        }
      }
    };
    const timer = setTimeout(() => done(new Error('Credential store timed out.')), 15000);
    child.stdout.on('data', (b) => {
      output += b.toString();
      if (output.length > 128 * 1024) done(new Error('Credential store response too large.'));
    });
    child.on('error', () => done(new Error('Credential store unavailable.')));
    child.stdin.on('error', () => done(new Error('Credential store unavailable.')));
    child.on('close', (code) =>
      done(code === 0 ? undefined : new Error('Credential store unavailable.')),
    );
    child.stdin.end(JSON.stringify({ operation, raw }));
  });
}
export class NativeAntigravityAccounts {
  private busy = false;
  private lastRefresh = 0;
  private readonly quota = new Map<string, { owner: string; account: AntigravityAccount }>();
  private owner(raw: string) {
    return createHash('sha256').update(raw).digest('hex');
  }
  private readonly root: string;
  private readonly tokenFile: string;
  constructor(
    dataDir: string,
    private readonly home = os.homedir(),
    private readonly store: AgyStore = {
      read: () => credentialBridge('read'),
      write: async (raw) => {
        await credentialBridge('write', raw);
      },
      rollbackEmpty: async () => {
        await credentialBridge('rollback-empty');
      },
    },
    private readonly request: typeof fetch = fetch,
  ) {
    this.root = path.join(dataDir, 'antigravity-accounts');
    this.tokenFile = path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  }
  private atomic(file: string, raw: string | Buffer) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.tmp';
    writeFileSync(tmp, raw, { mode: 0o600 });
    renameSync(tmp, file);
  }
  private key() {
    const file = path.join(this.root, 'encryption.key');
    if (!existsSync(file)) {
      if (existsSync(this.root) && readdirSync(this.root).some((name) => name.endsWith('.enc')))
        throw new Error('Saved account encryption key is missing; restore it from backup.');
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    return readFileSync(file);
  }
  private registry(): AntigravityAccount[] {
    const file = path.join(this.root, 'registry.json');
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as AntigravityAccount[]) : [];
  }
  private saveRegistry(rows: AntigravityAccount[]) {
    this.atomic(path.join(this.root, 'registry.json'), JSON.stringify(rows));
  }
  private encrypt(raw: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const data = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }
  private snapshot(raw: string, name?: string) {
    const meta = identity(raw);
    const file = path.join(this.root, meta.id + '.enc');
    this.atomic(file, this.encrypt(raw));
    const rows = this.registry();
    const existing = rows.find((a) => a.id === meta.id);
    if (existing) {
      existing.email = meta.email;
      if (name?.trim()) existing.name = name.trim();
    } else
      rows.push({
        ...meta,
        name: name?.trim() || meta.email || 'Antigravity account',
        active: false,
        plan: null,
        usage: { fiveHour: null, weekly: null, updatedAt: null },
      });
    this.saveRegistry(rows);
    return meta.id;
  }
  private decrypt(id: string) {
    if (!/^acct_[a-f0-9]{24}$/.test(id)) throw new Error('Account not found.');
    if (!existsSync(path.join(this.root, 'encryption.key')))
      throw new Error('Saved account encryption key is missing; restore it from backup.');
    const bytes = readFileSync(path.join(this.root, id + '.enc'));
    const decipher = createDecipheriv('aes-256-gcm', this.key(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
  private async current() {
    const keyring = await this.store.read();
    if (keyring) {
      parseAgyCredential(keyring);
      return keyring;
    }
    return existsSync(this.tokenFile) ? readFileSync(this.tokenFile, 'utf8') : null;
  }
  private accountView(raw: string, saved?: AntigravityAccount): AntigravityAccount {
    const meta = identity(raw);
    const cached = this.quota.get(meta.id);
    const report = cached?.owner === this.owner(raw) ? cached.account : null;
    const expiry = parseAgyCredential(raw).token.expiry;
    const expired =
      !expiry || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now();
    const generic =
      !saved ||
      saved.name === 'Antigravity account' ||
      saved.name === 'Default Antigravity account';
    return {
      ...meta,
      name: generic ? meta.email || 'Antigravity account' : saved!.name,
      active: false,
      plan: report?.plan ?? saved?.plan ?? null,
      usage: expired
        ? { fiveHour: null, weekly: null, updatedAt: null }
        : (report?.usage ?? { fiveHour: null, weekly: null, updatedAt: null }),
      limits: expired ? null : (report?.limits ?? null),
      usageStatus: expired
        ? 'expired'
        : report?.usageStatus === 'fresh' && !usageIsFresh(report.usage.updatedAt)
          ? 'stale'
          : (report?.usageStatus ?? 'not_loaded'),
    };
  }
  async state(refreshStale = false): Promise<AntigravityAccountsState> {
    const raw = await this.current();
    const active = raw ? identity(raw).id : null;
    const saved = this.registry();
    const accounts = saved.map((row) => {
      try {
        const credential = row.id === active && raw ? raw : this.decrypt(row.id);
        if (identity(credential).id !== row.id) throw new Error('Saved account identity mismatch.');
        return { ...this.accountView(credential, row), active: row.id === active };
      } catch {
        return {
          ...row,
          active: false,
          limits: null,
          usage: { fiveHour: null, weekly: null, updatedAt: null },
          usageStatus: 'unavailable' as const,
        };
      }
    });
    if (refreshStale && !this.busy && !usageIsFresh(new Date(this.lastRefresh).toISOString())) {
      this.lastRefresh = Date.now();
      void this.refresh().catch(() => undefined);
    }
    return {
      available: true,
      accounts,
      defaultAccount: raw
        ? {
            ...this.accountView(
              raw,
              saved.find((a) => a.id === active),
            ),
            active: true,
          }
        : null,
    };
  }
  private async exclusive(fn: () => Promise<AntigravityAccountsState>) {
    if (this.busy) throw new Error('An Antigravity account operation is already running.');
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }
  async saveCurrent(name?: string) {
    return this.exclusive(async () => {
      const raw = await this.current();
      if (!raw) throw new Error('Sign in with agy first, then save the current login.');
      this.snapshot(raw, name);
      return this.state();
    });
  }
  async import(raw: string, name?: string) {
    return this.exclusive(async () => {
      parseAgyCredential(raw);
      this.snapshot(raw, name);
      return this.state();
    });
  }
  async switch(id: string) {
    return this.exclusive(async () => {
      const raw = this.decrypt(id);
      parseAgyCredential(raw);
      const old = await this.current();
      if (old && identity(old).id === id) return this.state();
      if (old) {
        this.snapshot(old);
        this.atomic(path.join(this.root, 'previous.enc'), this.encrypt(old));
      }
      const oldMirror = existsSync(this.tokenFile) ? readFileSync(this.tokenFile) : null;
      // Prepare the file before changing the keyring. Both stores must agree on success.
      mkdirSync(path.dirname(this.tokenFile), { recursive: true, mode: 0o700 });
      const prepared = this.tokenFile + '.pm-next';
      writeFileSync(prepared, raw, { mode: 0o600 });
      try {
        await this.store.write(raw);
        renameSync(prepared, this.tokenFile);
        const checked = await this.store.read();
        if (!checked || checked !== raw || identity(checked).id !== id)
          throw new Error('Credential verification failed.');
      } catch {
        let restored = true;
        try {
          if (old) await this.store.write(old);
          else if (this.store.rollbackEmpty) await this.store.rollbackEmpty();
          else restored = false;
        } catch {
          restored = false;
        }
        try {
          if (oldMirror) this.atomic(this.tokenFile, oldMirror);
          else rmSync(this.tokenFile, { force: true });
        } catch {
          restored = false;
        }
        throw new Error(
          restored
            ? 'Account switch failed; previous login preserved. Refresh accounts before retrying.'
            : 'Account switch failed and rollback was incomplete. Restore the previous encrypted backup before retrying.',
        );
      } finally {
        rmSync(prepared, { force: true });
      }
      return this.state();
    });
  }
  async rename(id: string, name: string) {
    return this.exclusive(async () => {
      const rows = this.registry();
      const row = rows.find((a) => a.id === id);
      if (!row) throw new Error('Account not found.');
      row.name = name.trim() || row.email || 'Antigravity account';
      this.saveRegistry(rows);
      return this.state();
    });
  }
  async remove(id: string) {
    return this.exclusive(async () => {
      const rows = this.registry();
      if (!rows.some((a) => a.id === id)) throw new Error('Account not found.');
      this.saveRegistry(rows.filter((a) => a.id !== id));
      rmSync(path.join(this.root, id + '.enc'), { force: true });
      this.quota.delete(id);
      return this.state();
    });
  }
  async refresh(onlyId?: string) {
    return this.exclusive(async () => {
      const rows = this.registry();
      const active = await this.current();
      const savedIds = new Set(rows.map((a) => a.id));
      if (active && !savedIds.has(identity(active).id)) {
        const meta = identity(active);
        rows.unshift({
          ...meta,
          name: meta.email || 'Default Antigravity account',
          active: true,
          plan: null,
          usage: { fiveHour: null, weekly: null, updatedAt: null },
        });
      }
      for (const row of rows) {
        if (
          onlyId &&
          row.id !== onlyId &&
          !(onlyId === 'default' && active && row.id === identity(active).id)
        )
          continue;
        row.usage = { fiveHour: null, weekly: null, updatedAt: null };
        row.limits = null;
        row.usageStatus = 'unavailable';
        let raw: string | null = null;
        try {
          raw = active && identity(active).id === row.id ? active : this.decrypt(row.id);
          if (identity(raw).id !== row.id) throw new Error('Saved account identity mismatch.');
          const credential = parseAgyCredential(raw);
          if (
            !credential.token.access_token ||
            !credential.token.expiry ||
            !Number.isFinite(Date.parse(credential.token.expiry)) ||
            Date.parse(credential.token.expiry) <= Date.now()
          )
            continue;
          let project = 'default-cli-project';
          const projectFile = path.join(
            this.home,
            '.gemini',
            'antigravity-cli',
            'cache',
            'default_project_id.txt',
          );
          if (existsSync(projectFile))
            project = readFileSync(projectFile, 'utf8').trim() || project;
          const post = async (method: string, body: unknown) => {
            const res = await this.request(
              'https://daily-cloudcode-pa.googleapis.com/v1internal:' + method,
              {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.timeout(15000),
                headers: {
                  Authorization: 'Bearer ' + credential.token.access_token,
                  'Content-Type': 'application/json',
                  'User-Agent': `antigravity/cli/1.4.5 (ProjectManager; os_type=${process.platform}; arch=${process.arch}; auth_method=consumer)`,
                },
                body: JSON.stringify(body),
              },
            );
            if (!res.ok) throw new Error('Quota unavailable');
            const text = await res.text();
            if (text.length > 1024 * 1024) throw new Error('Quota response too large');
            return JSON.parse(text) as Record<string, unknown>;
          };
          const assist = await post('loadCodeAssist', {
            cloudaicompanionProject: project,
            metadata: {
              ideType: 'IDE_UNSPECIFIED',
              platform: 'PLATFORM_UNSPECIFIED',
              pluginType: 'GEMINI',
              duetProject: project,
            },
          });
          const summary = await post('retrieveUserQuotaSummary', { project });
          const tier = assist.paidTier ?? assist.currentTier;
          if (tier && typeof tier === 'object' && 'name' in tier && typeof tier.name === 'string')
            row.plan = tier.name;
          const groups = z
            .object({
              groups: z.array(
                z.object({
                  buckets: z.array(
                    z.object({
                      window: z.string().optional(),
                      bucketId: z.string().optional(),
                      remainingFraction: z.number().min(0).max(1).optional(),
                      resetTime: z.string().optional(),
                    }),
                  ),
                }),
              ),
            })
            .parse(summary);
          const windows = new Map<string, UsageWindow>();
          for (const group of groups.groups)
            for (const bucket of group.buckets) {
              if (bucket.remainingFraction === undefined) continue;
              const label = (bucket.window || bucket.bucketId || '').toLowerCase();
              const key = /weekly|week/.test(label)
                ? 'weekly'
                : /5h|5-hour|five/.test(label)
                  ? 'fiveHour'
                  : null;
              if (key) {
                row.usage[key] = Math.max(
                  row.usage[key] ?? 0,
                  Math.round((1 - bucket.remainingFraction) * 100),
                );
                const usedPercent = (1 - bucket.remainingFraction) * 100;
                if (!windows.has(key) || usedPercent > windows.get(key)!.usedPercent)
                  windows.set(key, {
                    label: key === 'weekly' ? 'Weekly' : '5-hour',
                    windowMinutes: key === 'weekly' ? 10080 : 300,
                    usedPercent,
                    resetsAt:
                      bucket.resetTime && Number.isFinite(Date.parse(bucket.resetTime))
                        ? new Date(bucket.resetTime).toISOString()
                        : null,
                  });
              }
            }
          row.usage.updatedAt = new Date().toISOString();
          row.limits = windows.size
            ? {
                providerId: 'antigravity',
                source: 'Antigravity quota service',
                asOf: row.usage.updatedAt,
                windows: [...windows.values()],
              }
            : null;
          row.usageStatus = 'fresh';
        } catch {
          /* Failed quota stays unavailable, never another account's cached value. */
        }
        if (raw) this.quota.set(row.id, { owner: this.owner(raw), account: structuredClone(row) });
      }
      this.saveRegistry(
        rows
          .filter((a) => savedIds.has(a.id))
          .map((row) => ({
            ...row,
            limits: null,
            usage: { fiveHour: null, weekly: null, updatedAt: null },
            usageStatus: 'not_loaded',
          })),
      );
      if (!onlyId) this.lastRefresh = Date.now();
      return this.state();
    });
  }
}
