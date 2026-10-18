import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { getSetting, setSetting } from '../store.js';
import type { CodexAccount, CodexAccountsState } from '../../shared/types.js';
import { codexLimits } from './limits.js';
import { readCodexAccountUsage, type AccountUsageResult } from './accountUsage.js';

const REGISTRY = 'codex-accounts.json';
const ACTIVE_KEY = 'codex-accounts-active';
const AUTO_SWITCH_KEY = 'codex-accounts-auto-switch';
/** Last usage read per account home (limits and times only, never credentials). */
const USAGE_KEY = 'codex-accounts-usage';
/** Opening the accounts panel re-reads usage older than this, in the background. */
export const USAGE_MAX_AGE_MS = 10 * 60_000;
const MAX_AUTH_BYTES = 1024 * 1024;

interface StoredAccount {
  id: string;
  name: string;
  createdAt: string;
  email?: string | null;
  plan?: string | null;
}

interface Registry {
  version: 1;
  activeProfileId?: string | null;
  accounts: StoredAccount[];
}

export class CodexAccountError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export class CodexAccounts {
  private readonly usage = new Map<string, AccountUsageResult>();
  private refreshingUsage: Promise<CodexAccountsState> | null = null;

  /** Every signed-in account home: the default login and each saved profile. */
  private usageHomes(): string[] {
    return [this.defaultHome(), ...this.readRegistry().accounts.map((a) => this.home(a.id))].filter(
      (home) => existsSync(path.join(home, 'auth.json')),
    );
  }

  /**
   * Where each home's usage is read from (PM-173). Usage belongs to the account, so homes with
   * the same email share one read, from the first of them (the default login first). A second
   * copy of a login is never started just to read usage: the CLI refreshes its token on start,
   * and refresh tokens are single-use, so that could end the other copy's session.
   */
  private usageSources(): Map<string, string> {
    const emails = new Map(
      this.readRegistry().accounts.map((a) => [this.home(a.id), a.email ?? undefined]),
    );
    const firstByEmail = new Map<string, string>();
    const sources = new Map<string, string>();
    for (const home of this.usageHomes()) {
      const email = (
        home === this.defaultHome() || emails.get(home) === undefined
          ? this.readAuthMeta(path.join(home, 'auth.json')).email
          : emails.get(home)
      )?.toLowerCase();
      if (email && !firstByEmail.has(email)) firstByEmail.set(email, home);
      sources.set(home, (email && firstByEmail.get(email)) || home);
    }
    return sources;
  }

  /** The homes usage is actually read from: one per account. */
  private usageReadHomes(): string[] {
    return [...new Set(this.usageSources().values())];
  }

  /**
   * Reads usage for every account (or only those `stale` picks), two at a time, through the
   * read-only account service. Results are kept across restarts (PM-173), so each profile
   * shows its last known usage and when it was checked.
   */
  refreshUsage(
    reader = readCodexAccountUsage,
    stale: (home: string) => boolean = () => true,
  ): Promise<CodexAccountsState> {
    if (this.refreshingUsage) return this.refreshingUsage;
    const run = (async () => {
      const homes = this.usageReadHomes().filter(stale);
      for (let i = 0; i < homes.length; i += 2) {
        await Promise.all(
          homes.slice(i, i + 2).map(async (home) => {
            const result = await reader(home);
            // A failed read keeps the last known numbers, labelled with the failure.
            const known = this.usage.get(home)?.limits;
            this.usage.set(home, result.limits || !known ? result : { ...result, limits: known });
          }),
        );
        this.saveUsage();
      }
    })();
    // Cleared before the final state is built, so it no longer reports a refresh running.
    this.refreshingUsage = run.then(
      () => {
        this.refreshingUsage = null;
        return this.state();
      },
      (error: unknown) => {
        this.refreshingUsage = null;
        throw error;
      },
    );
    return this.refreshingUsage;
  }

  /**
   * Stale-while-revalidate for the accounts panel: answers with what is known now and starts a
   * background read of accounts whose usage is missing or older than `maxAgeMs`.
   */
  refreshUsageIfStale(
    maxAgeMs = USAGE_MAX_AGE_MS,
    now = Date.now(),
    reader = readCodexAccountUsage,
  ): void {
    if (this.refreshingUsage) return;
    const stale = (home: string) => {
      const known = this.usage.get(home);
      return !known || !(now - Date.parse(known.checkedAt) <= maxAgeMs);
    };
    if (!this.usageReadHomes().some(stale)) return;
    void this.refreshUsage(reader, stale).catch((error: Error) => {
      console.error('[codex-accounts] usage refresh:', error);
    });
  }

  private loadUsage(): void {
    const saved = getSetting<Record<string, AccountUsageResult>>(this.db, USAGE_KEY) ?? {};
    for (const [home, result] of Object.entries(saved)) this.usage.set(home, result);
  }

  private saveUsage(): void {
    // Only homes that still exist: a removed profile's usage is dropped with it.
    const homes = new Set(this.usageHomes());
    setSetting(
      this.db,
      USAGE_KEY,
      Object.fromEntries([...this.usage].filter(([home]) => homes.has(home))),
    );
  }

  private usageState(home: string, now: number, source = home) {
    // A copy known to be signed out says so, rather than showing the other copy's usage.
    const own = this.usage.get(home);
    const current = own?.status === 'expired' ? own : (this.usage.get(source) ?? own);
    const limits = current?.limits ?? codexLimits(os.homedir(), home, now);
    const usageStatus =
      current?.status === 'fresh' && now - Date.parse(current.checkedAt) > 60000
        ? ('stale' as const)
        : (current?.status ?? (limits ? ('stale' as const) : ('not_loaded' as const)));
    return { limits, usageStatus, usageCheckedAt: current?.checkedAt ?? null };
  }
  private readonly root: string;

  constructor(
    private readonly dataDir: string,
    private readonly db: Db,
  ) {
    this.root = path.join(dataDir, 'codex-accounts');
    this.loadUsage();
  }

  state(now = Date.now()): CodexAccountsState {
    const registry = this.readRegistry();
    const saved = getSetting<string | null>(this.db, ACTIVE_KEY);
    const candidate = saved !== undefined ? saved : (registry.activeProfileId ?? null);
    const activeProfileId =
      candidate && registry.accounts.some((account) => account.id === candidate) ? candidate : null;
    const autoSwitch = getSetting<boolean>(this.db, AUTO_SWITCH_KEY) ?? true;
    const defHome = this.defaultHome();
    const defAuthFile = path.join(defHome, 'auth.json');
    const defMeta = this.readAuthMeta(defAuthFile);
    const sources = this.usageSources();
    const defaultAccount = {
      available: existsSync(defAuthFile),
      email: defMeta.email,
      plan: defMeta.plan,
      ...this.usageState(defHome, now, sources.get(defHome)),
    };
    const accounts: CodexAccount[] = registry.accounts.map((account) => {
      const home = this.home(account.id);
      const meta =
        account.email !== undefined || account.plan !== undefined
          ? { email: account.email ?? null, plan: account.plan ?? null }
          : this.readAuthMeta(path.join(home, 'auth.json'));
      return {
        id: account.id,
        name: account.name,
        createdAt: account.createdAt,
        email: meta.email,
        plan: meta.plan,
        ...this.usageState(home, now, sources.get(home)),
      };
    });
    return {
      accounts,
      activeProfileId,
      autoSwitch,
      defaultAccount,
      usageRefreshing: this.refreshingUsage !== null,
    };
  }

  setActive(id: string | null): CodexAccountsState {
    const normalized = id === 'default' ? null : id;
    if (normalized !== null && !this.account(normalized))
      throw new CodexAccountError(404, 'Codex account not found');
    setSetting(this.db, ACTIVE_KEY, normalized);
    const registryFile = path.join(this.dataDir, REGISTRY);
    if (existsSync(registryFile) || normalized !== null) {
      const registry = this.readRegistry();
      this.writeRegistry({ ...registry, activeProfileId: normalized });
    }
    return this.state();
  }

  setAutoSwitch(enabled: boolean): CodexAccountsState {
    setSetting(this.db, AUTO_SWITCH_KEY, enabled);
    return this.state();
  }

  importAccount(name: string, authJson: string): CodexAccountsState {
    if (Buffer.byteLength(authJson, 'utf8') > MAX_AUTH_BYTES)
      throw new CodexAccountError(400, 'Codex auth file is larger than 1 MB');
    let parsed: unknown;
    try {
      parsed = JSON.parse(authJson) as unknown;
    } catch {
      throw new CodexAccountError(400, 'The selected file is not valid JSON');
    }
    const auth = normalizeCodexAuth(parsed);
    if (!auth)
      throw new CodexAccountError(400, 'The selected JSON does not contain Codex credentials');

    const meta = extractCodexAuthMeta(auth, parsed);
    const fallbackName = name.trim() || meta.email || '';
    const cleanName = this.cleanName(fallbackName);

    const id = randomUUID();
    const dir = this.home(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      // Keep the user's model, MCP and approval preferences while separating auth and session
      // history. Never copy the default auth.json into a newly imported profile.
      this.syncConfigToml(dir);
      this.writePrivate(path.join(dir, 'auth.json'), `${JSON.stringify(auth)}\n`);

      const registry = this.readRegistry();
      registry.accounts.push({
        id,
        name: cleanName,
        createdAt: new Date().toISOString(),
        email: meta.email,
        plan: meta.plan,
      });
      this.writeRegistry(registry);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return this.state();
  }

  /** Saves the current default CODEX_HOME/auth.json into the managed account registry (like `codex-auth login`). */
  saveCurrentAccount(name = ''): CodexAccountsState {
    const authFile = path.join(this.defaultHome(), 'auth.json');
    if (!existsSync(authFile)) {
      throw new CodexAccountError(
        404,
        'No Codex auth.json found in the default CODEX_HOME. Run codex login first or import a saved JSON file.',
      );
    }
    const raw = readFileSync(authFile, 'utf8');
    const meta = this.readAuthMeta(authFile);
    const state = this.importAccount(name.trim() || meta.email || 'Default login copy', raw);
    const newest = state.accounts.at(-1);
    if (newest) {
      // Move the default auth.json into the saved profile and make that profile active so a
      // subsequent `codex logout` in the default ~/.codex folder cannot revoke the saved token
      // on OpenAI's server (PM-173).
      try {
        rmSync(authFile, { force: true });
      } catch {
        // Best-effort cleanup of default auth.json.
      }
      return this.setActive(newest.id);
    }
    return state;
  }

  renameAccount(id: string, name: string): CodexAccountsState {
    if (!this.account(id)) throw new CodexAccountError(404, 'Codex account not found');
    const cleanName = this.cleanName(name);
    const registry = this.readRegistry();
    this.writeRegistry({
      ...registry,
      accounts: registry.accounts.map((account) =>
        account.id === id ? { ...account, name: cleanName } : account,
      ),
    });
    return this.state();
  }

  removeAccount(id: string): CodexAccountsState {
    const account = this.account(id);
    if (!account) throw new CodexAccountError(404, 'Codex account not found');
    const profileHome = this.home(id);
    if (this.isReferenced(profileHome))
      throw new CodexAccountError(
        409,
        'Remove the Codex sessions and runs using this account before removing it',
      );

    const registry = this.readRegistry();
    const nextActive = registry.activeProfileId === id ? null : registry.activeProfileId;
    this.writeRegistry({
      ...registry,
      activeProfileId: nextActive,
      accounts: registry.accounts.filter((item) => item.id !== id),
    });
    try {
      rmSync(profileHome, { recursive: true, force: true });
    } catch (error) {
      this.writeRegistry(registry);
      throw error;
    }
    if (getSetting(this.db, ACTIVE_KEY) === id) setSetting(this.db, ACTIVE_KEY, null);
    return this.state();
  }

  selectedHome(): string {
    return this.profile(this.selectedId()).home;
  }

  selectedId(): string {
    const saved = getSetting<string | null>(this.db, ACTIVE_KEY);
    if (saved && this.account(saved)) return saved;
    if (saved === undefined) {
      const regActive = this.readRegistry().activeProfileId ?? null;
      if (regActive && this.account(regActive)) return regActive;
    }
    return 'default';
  }

  profile(id: string): { id: string; name: string; home: string } {
    if (id === 'default') return { id, name: 'Default Codex account', home: this.defaultHome() };
    const account = this.account(id);
    if (!account) throw new CodexAccountError(404, 'Codex account not found');
    const home = this.home(account.id);
    this.syncConfigToml(home);
    return { id: account.id, name: account.name, home };
  }

  selectedProfile(): { id: string; name: string; home: string } {
    return this.profile(this.selectedId());
  }

  homeForKey(key: string): string | null {
    if (key === 'default') return this.defaultHome();
    return this.account(key) ? this.home(key) : null;
  }

  keyForHome(value: string | undefined): string | null {
    if (!value) return null;
    const home = normalPath(value);
    if (home === normalPath(this.defaultHome())) return 'default';
    return (
      this.readRegistry().accounts.find((account) => normalPath(this.home(account.id)) === home)
        ?.id ?? null
    );
  }

  /**
   * Picks the next untried Codex profile in round-robin order after `currentKey`.
   * Prefers a candidate whose local rate-limit report is not currently exhausted (>= 99%),
   * falling back to the first untried candidate when limits are unknown.
   */
  nextUnused(
    currentKey: string | null,
    tried: readonly string[],
    now = Date.now(),
  ): { id: string; name: string; home: string } | null {
    const accounts = [
      { id: 'default', name: 'Default Codex account', home: this.defaultHome() },
      ...this.readRegistry().accounts.map((account) => ({
        id: account.id,
        name: account.name,
        home: this.home(account.id),
      })),
    ];
    const currentIndex = accounts.findIndex((account) => account.id === currentKey);
    const untried: { id: string; name: string; home: string }[] = [];
    for (let offset = 1; offset <= accounts.length; offset++) {
      const candidate = accounts[(Math.max(currentIndex, -1) + offset) % accounts.length]!;
      if (!tried.includes(candidate.id)) untried.push(candidate);
    }
    if (untried.length === 0) return null;
    const nonExhausted = untried.find((candidate) => !this.isExhausted(candidate.home, now));
    const chosen = nonExhausted ?? untried[0]!;
    if (chosen.id !== 'default') this.syncConfigToml(chosen.home);
    return chosen;
  }

  /**
   * Copies a rollout into another Codex home. Do not use this to resume a thread on a different
   * ChatGPT account: Codex refuses that resume and reports that the access token was revoked.
   */
  copyRolloutToHome(fromHome: string, toHome: string, rolloutFile: string | null): void {
    if (normalPath(fromHome) === normalPath(toHome)) return;
    if (toHome !== this.defaultHome()) this.syncConfigToml(toHome);
    if (rolloutFile && existsSync(rolloutFile)) {
      const rel = path.relative(fromHome, rolloutFile);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        const dest = path.join(toHome, rel);
        try {
          mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
          copyFileSync(rolloutFile, dest);
        } catch {
          // Best-effort copy; session still restarts.
        }
      }
    }
    const indexSrc = path.join(fromHome, 'session_index.jsonl');
    const indexDest = path.join(toHome, 'session_index.jsonl');
    if (existsSync(indexSrc) && !existsSync(indexDest)) {
      try {
        mkdirSync(toHome, { recursive: true, mode: 0o700 });
        copyFileSync(indexSrc, indexDest);
      } catch {
        // Best-effort.
      }
    }
  }

  private isExhausted(home: string, now: number): boolean {
    const limits = codexLimits(os.homedir(), home, now);
    if (!limits) return false;
    return limits.windows.some(
      (w) => w.usedPercent >= 99 && (!w.resetsAt || Date.parse(w.resetsAt) > now),
    );
  }

  private syncConfigToml(targetHome: string): void {
    // The default login keeps the user's own credential store (often the OS keyring). A saved
    // profile must read the auth.json in its own CODEX_HOME, or Codex keeps the other account
    // and then fails the refresh with "signed in to another account".
    if (normalPath(targetHome) === normalPath(this.defaultHome())) return;
    const config = path.join(this.defaultHome(), 'config.toml');
    const destination = path.join(targetHome, 'config.toml');
    if (existsSync(config) && !existsSync(destination)) {
      try {
        mkdirSync(targetHome, { recursive: true, mode: 0o700 });
        copyFileSync(config, destination);
        chmodSync(destination, 0o600);
      } catch {
        // Best-effort config copy. The credential-store line below still has to land.
      }
    }
    try {
      this.ensureFileCredentialStore(destination);
    } catch {
      // A profile Codex cannot configure falls back to its existing config.
    }
  }

  /**
   * Saved profiles authenticate from their own auth.json, not the machine keyring.
   * In TOML, top-level keys MUST appear before the first `[table]` section header — appending
   * at the end of `config.toml` placed `cli_auth_credentials_store` inside `[notice]` (PM-173).
   */
  private ensureFileCredentialStore(configPath: string): void {
    const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    const line = 'cli_auth_credentials_store = "file"';
    const stripped = current
      .split(/\r?\n/)
      .filter((l) => !/^[ \t]*cli_auth_credentials_store[ \t]*=/.test(l))
      .join('\n')
      .replace(/^\n+/, '');
    const next = stripped
      ? `${line}\n${stripped.endsWith('\n') ? stripped : `${stripped}\n`}`
      : `${line}\n`;
    if (next === current) return;
    mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    this.writePrivate(configPath, next);
  }

  private readAuthMeta(authFile: string): { email: string | null; plan: string | null } {
    if (!existsSync(authFile)) return { email: null, plan: null };
    try {
      const raw = JSON.parse(readFileSync(authFile, 'utf8')) as unknown;
      const auth = normalizeCodexAuth(raw);
      return auth ? extractCodexAuthMeta(auth, raw) : { email: null, plan: null };
    } catch {
      return { email: null, plan: null };
    }
  }

  private account(id: string): StoredAccount | undefined {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    return this.readRegistry().accounts.find((account) => account.id === id);
  }

  private cleanName(name: string): string {
    const clean = [...name.trim()]
      .filter((ch) => ch >= ' ' && ch !== '\x7f')
      .join('')
      .slice(0, 64);
    if (!clean) throw new CodexAccountError(400, 'Enter a name for this account');
    return clean;
  }

  private home(id: string): string {
    return path.join(this.root, id);
  }

  private defaultHome(): string {
    return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  }

  private readRegistry(): Registry {
    const file = path.join(this.dataDir, REGISTRY);
    if (!existsSync(file)) return { version: 1, accounts: [] };
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as Registry;
      if (value.version !== 1 || !Array.isArray(value.accounts)) throw new Error();
      return value;
    } catch {
      throw new Error(
        'The saved Codex account registry is unreadable; no account files were changed',
      );
    }
  }

  private writeRegistry(registry: Registry): void {
    mkdirSync(this.dataDir, { recursive: true });
    this.writePrivate(path.join(this.dataDir, REGISTRY), `${JSON.stringify(registry, null, 2)}\n`);
  }

  private writePrivate(file: string, contents: string): void {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      chmodSync(temp, 0o600);
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  private isReferenced(home: string): boolean {
    for (const table of ['agent_sessions', 'agent_runs'] as const) {
      const rows = this.db.prepare(`SELECT command_json FROM ${table}`).all() as {
        command_json: string;
      }[];
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.command_json) as {
            env?: Record<string, string>;
            codexAccountId?: string;
          };
          if (
            parsed.codexAccountId === path.basename(home) ||
            (parsed.env?.CODEX_HOME && normalPath(parsed.env.CODEX_HOME) === normalPath(home))
          )
            return true;
        } catch {
          // Historical or custom command data can be unreadable; it does not identify this profile.
        }
      }
    }
    return false;
  }
}

/**
 * Accepts standard Codex `auth.json` (`{ tokens: {...} }` or `{ OPENAI_API_KEY: "sk-..." }`)
 * as well as flat CLIProxyAPI / OAuth token JSON (`{ access_token, refresh_token, id_token }`,
 * converted to Codex's `{ OPENAI_API_KEY: null, tokens: ... }` layout).
 */
export function normalizeCodexAuth(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const auth = value as Record<string, unknown>;
  const tokens = auth.tokens;
  if (typeof tokens === 'object' && tokens !== null && !Array.isArray(tokens)) {
    const t = tokens as Record<string, unknown>;
    const hasToken =
      (typeof t.access_token === 'string' && t.access_token.length > 0) ||
      (typeof t.refresh_token === 'string' && t.refresh_token.length > 0) ||
      (typeof t.id_token === 'string' && t.id_token.length > 0) ||
      (typeof t.account_id === 'string' && t.account_id.length > 0);
    if (hasToken || Object.keys(t).length > 0) return auth;
  }
  if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim().length > 0) {
    return auth;
  }
  // Flat OAuth / CLIProxyAPI token object (`codex-auth import --cpa` style).
  if (
    (typeof auth.access_token === 'string' && auth.access_token.length > 0) ||
    (typeof auth.refresh_token === 'string' && auth.refresh_token.length > 0) ||
    (typeof auth.id_token === 'string' && auth.id_token.length > 0)
  ) {
    return {
      OPENAI_API_KEY: null,
      tokens: {
        ...(typeof auth.id_token === 'string' ? { id_token: auth.id_token } : {}),
        ...(typeof auth.access_token === 'string' ? { access_token: auth.access_token } : {}),
        ...(typeof auth.refresh_token === 'string' ? { refresh_token: auth.refresh_token } : {}),
        ...(typeof auth.account_id === 'string' ? { account_id: auth.account_id } : {}),
      },
      last_refresh:
        typeof auth.last_refresh === 'string' ? auth.last_refresh : new Date().toISOString(),
    };
  }
  return null;
}

/** Extracts non-secret display metadata (email and plan tier) from JWT claims or top-level fields. */
export function extractCodexAuthMeta(
  normalized: Record<string, unknown>,
  raw?: unknown,
): { email: string | null; plan: string | null } {
  const rawObj =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const tokens =
    normalized.tokens && typeof normalized.tokens === 'object' && !Array.isArray(normalized.tokens)
      ? (normalized.tokens as Record<string, unknown>)
      : {};
  let email: string | null = typeof rawObj.email === 'string' ? rawObj.email.trim() || null : null;
  let plan: string | null = typeof rawObj.plan === 'string' ? rawObj.plan.trim() || null : null;

  for (const key of ['id_token', 'access_token'] as const) {
    const jwt = tokens[key];
    if (typeof jwt !== 'string') continue;
    const claims = decodeJwtPayload(jwt);
    if (!claims) continue;
    if (!email) {
      const profile = claims['https://api.openai.com/profile'] as
        Record<string, unknown> | undefined;
      const candidate =
        typeof claims.email === 'string'
          ? claims.email
          : typeof profile?.email === 'string'
            ? profile.email
            : null;
      if (candidate?.trim()) email = candidate.trim();
    }
    if (!plan) {
      const authClaim = claims['https://api.openai.com/auth'] as
        Record<string, unknown> | undefined;
      const candidate =
        typeof authClaim?.chatgpt_plan_type === 'string'
          ? authClaim.chatgpt_plan_type
          : typeof claims.plan_type === 'string'
            ? claims.plan_type
            : null;
      if (candidate?.trim()) plan = candidate.trim();
    }
  }
  if (
    !plan &&
    typeof normalized.OPENAI_API_KEY === 'string' &&
    normalized.OPENAI_API_KEY.trim().length > 0
  ) {
    plan = 'api_key';
  }
  return { email, plan };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalPath(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

const CLAUDE_REGISTRY = 'claude-accounts.json';
const CLAUDE_ACTIVE_KEY = 'claude-accounts-active';
const CLAUDE_AUTO_SWITCH_KEY = 'claude-accounts-auto-switch';

/**
 * Saved Claude Code accounts (PM-169): manages `.credentials.json` profiles alongside the user's
 * default `~/.claude/.credentials.json` login so operators can switch or import Claude accounts
 * in Settings > Agent CLIs just like Codex.
 */
export class ClaudeAccounts {
  private readonly root: string;

  constructor(
    private readonly dataDir: string,
    private readonly db: Db,
  ) {
    this.root = path.join(dataDir, 'claude-accounts');
  }

  state(_now = Date.now()): CodexAccountsState {
    const registry = this.readRegistry();
    const saved = getSetting<string | null>(this.db, CLAUDE_ACTIVE_KEY) ?? null;
    const activeProfileId =
      saved && registry.accounts.some((account) => account.id === saved) ? saved : null;
    const autoSwitch = getSetting<boolean>(this.db, CLAUDE_AUTO_SWITCH_KEY) ?? true;
    const defCredsFile = this.defaultBackupCredsFile();
    const liveCredsFile = path.join(this.defaultHome(), '.credentials.json');
    const sourceCredsFile = activeProfileId ? defCredsFile : liveCredsFile;
    const defMeta = this.readAuthMeta(sourceCredsFile, activeProfileId === null);
    const defaultAccount = {
      available: existsSync(sourceCredsFile),
      email: defMeta.email,
      plan: defMeta.plan,
      limits: null,
      usageStatus: 'unsupported' as const,
    };
    const accounts: CodexAccount[] = registry.accounts.map((account) => {
      const home = this.home(account.id);
      const meta =
        account.email !== undefined || account.plan !== undefined
          ? { email: account.email ?? null, plan: account.plan ?? null }
          : this.readAuthMeta(path.join(home, '.credentials.json'), false);
      return {
        id: account.id,
        name: account.name,
        createdAt: account.createdAt,
        email: meta.email,
        plan: meta.plan,
        limits: null,
        usageStatus: 'unsupported' as const,
      };
    });
    return { accounts, activeProfileId, autoSwitch, defaultAccount };
  }

  setActive(id: string | null): CodexAccountsState {
    const normalized = id === 'default' ? null : id;
    const account = normalized !== null ? this.account(normalized) : undefined;
    if (normalized !== null && !account)
      throw new CodexAccountError(404, 'Claude account not found');

    const currentActive = getSetting<string | null>(this.db, CLAUDE_ACTIVE_KEY) ?? null;
    const liveCreds = path.join(this.defaultHome(), '.credentials.json');
    const backupCreds = this.defaultBackupCredsFile();

    // Claude refreshes tokens in the live file. Preserve those refreshed credentials before
    // replacing them with another profile, so switching back does not restore expired tokens.
    if (currentActive && this.account(currentActive) && existsSync(liveCreds)) {
      this.writePrivate(
        path.join(this.home(currentActive), '.credentials.json'),
        readFileSync(liveCreds, 'utf8'),
      );
    }

    if (currentActive === null && normalized !== null) {
      if (existsSync(liveCreds)) {
        mkdirSync(path.dirname(backupCreds), { recursive: true, mode: 0o700 });
        this.writePrivate(backupCreds, readFileSync(liveCreds, 'utf8'));
      } else {
        rmSync(backupCreds, { force: true });
      }
    }

    if (normalized === null) {
      if (existsSync(backupCreds)) {
        mkdirSync(this.defaultHome(), { recursive: true, mode: 0o700 });
        this.writePrivate(liveCreds, readFileSync(backupCreds, 'utf8'));
      } else if (currentActive !== null) {
        rmSync(liveCreds, { force: true });
      }
    } else {
      const profileCreds = path.join(this.home(normalized), '.credentials.json');
      if (!existsSync(profileCreds))
        throw new CodexAccountError(409, 'The saved Claude credentials file is missing');
      mkdirSync(this.defaultHome(), { recursive: true, mode: 0o700 });
      this.writePrivate(liveCreds, readFileSync(profileCreds, 'utf8'));
    }

    setSetting(this.db, CLAUDE_ACTIVE_KEY, normalized);
    const registryFile = path.join(this.dataDir, CLAUDE_REGISTRY);
    if (existsSync(registryFile) || normalized !== null) {
      const registry = this.readRegistry();
      this.writeRegistry({ ...registry, activeProfileId: normalized });
    }
    return this.state();
  }

  setAutoSwitch(enabled: boolean): CodexAccountsState {
    setSetting(this.db, CLAUDE_AUTO_SWITCH_KEY, enabled);
    return this.state();
  }

  importAccount(name: string, authJson: string): CodexAccountsState {
    if (Buffer.byteLength(authJson, 'utf8') > MAX_AUTH_BYTES)
      throw new CodexAccountError(400, 'Claude credentials file is larger than 1 MB');
    let parsed: unknown;
    try {
      parsed = JSON.parse(authJson) as unknown;
    } catch {
      throw new CodexAccountError(400, 'The selected file is not valid JSON');
    }
    const auth = normalizeClaudeAuth(parsed);
    if (!auth)
      throw new CodexAccountError(400, 'The selected JSON does not contain Claude credentials');

    const meta = extractClaudeAuthMeta(auth, parsed);
    const fallbackName = name.trim() || meta.email || '';
    const cleanName = this.cleanName(fallbackName);

    const id = randomUUID();
    const dir = this.home(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      this.writePrivate(path.join(dir, '.credentials.json'), `${JSON.stringify(auth)}\n`);
      const registry = this.readRegistry();
      registry.accounts.push({
        id,
        name: cleanName,
        createdAt: new Date().toISOString(),
        email: meta.email,
        plan: meta.plan,
      });
      this.writeRegistry(registry);
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return this.state();
  }

  saveCurrentAccount(name = ''): CodexAccountsState {
    const credsFile = path.join(this.defaultHome(), '.credentials.json');
    if (!existsSync(credsFile)) {
      throw new CodexAccountError(
        404,
        'No Claude .credentials.json found in ~/.claude. Sign in with Claude Code first or import a saved JSON file.',
      );
    }
    const raw = readFileSync(credsFile, 'utf8');
    const meta = this.readAuthMeta(credsFile, true);
    let enrichedRaw = raw;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (meta.email && !parsed.email) parsed.email = meta.email;
      if (meta.plan && !parsed.plan) parsed.plan = meta.plan;
      enrichedRaw = JSON.stringify(parsed);
    } catch {
      // Keep original raw JSON if it cannot be enriched.
    }
    return this.importAccount(name.trim() || meta.email || 'Default login copy', enrichedRaw);
  }

  renameAccount(id: string, name: string): CodexAccountsState {
    if (!this.account(id)) throw new CodexAccountError(404, 'Claude account not found');
    const cleanName = this.cleanName(name);
    const registry = this.readRegistry();
    this.writeRegistry({
      ...registry,
      accounts: registry.accounts.map((account) =>
        account.id === id ? { ...account, name: cleanName } : account,
      ),
    });
    return this.state();
  }

  removeAccount(id: string): CodexAccountsState {
    const account = this.account(id);
    if (!account) throw new CodexAccountError(404, 'Claude account not found');
    const profileHome = this.home(id);
    const registry = this.readRegistry();
    const nextActive = registry.activeProfileId === id ? null : registry.activeProfileId;
    this.writeRegistry({
      ...registry,
      activeProfileId: nextActive,
      accounts: registry.accounts.filter((item) => item.id !== id),
    });
    rmSync(profileHome, { recursive: true, force: true });
    if (getSetting(this.db, CLAUDE_ACTIVE_KEY) === id) {
      this.setActive(null);
    }
    return this.state();
  }

  private readAuthMeta(
    credsFile: string,
    includeGlobalConfig: boolean,
  ): { email: string | null; plan: string | null } {
    let email: string | null = null;
    let plan: string | null = null;
    if (existsSync(credsFile)) {
      try {
        const raw = JSON.parse(readFileSync(credsFile, 'utf8')) as unknown;
        const auth = normalizeClaudeAuth(raw);
        if (auth) {
          const meta = extractClaudeAuthMeta(auth, raw);
          email = meta.email;
          plan = meta.plan;
        }
      } catch {
        // Ignore unreadable credentials file.
      }
    }
    if (includeGlobalConfig && (!email || !plan)) {
      const globalClaudeJson = path.join(os.homedir(), '.claude.json');
      if (existsSync(globalClaudeJson)) {
        try {
          const parsed = JSON.parse(readFileSync(globalClaudeJson, 'utf8')) as {
            oauthAccount?: { emailAddress?: string; billingType?: string; seatTier?: string };
          };
          if (!email && typeof parsed.oauthAccount?.emailAddress === 'string') {
            email = parsed.oauthAccount.emailAddress.trim() || null;
          }
          if (!plan && typeof parsed.oauthAccount?.seatTier === 'string') {
            plan = parsed.oauthAccount.seatTier.trim() || null;
          }
        } catch {
          // Ignore unreadable ~/.claude.json.
        }
      }
    }
    return { email, plan };
  }

  private account(id: string): StoredAccount | undefined {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    return this.readRegistry().accounts.find((account) => account.id === id);
  }

  private cleanName(name: string): string {
    const clean = [...name.trim()]
      .filter((ch) => ch >= ' ' && ch !== '\x7f')
      .join('')
      .slice(0, 64);
    if (!clean) throw new CodexAccountError(400, 'Enter a name for this account');
    return clean;
  }

  private home(id: string): string {
    return path.join(this.root, id);
  }

  private defaultBackupCredsFile(): string {
    return path.join(this.root, 'default', '.credentials.json');
  }

  private defaultHome(): string {
    return path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  }

  private readRegistry(): Registry {
    const file = path.join(this.dataDir, CLAUDE_REGISTRY);
    if (!existsSync(file)) return { version: 1, accounts: [] };
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as Registry;
      if (value.version !== 1 || !Array.isArray(value.accounts)) throw new Error();
      return value;
    } catch {
      throw new Error(
        'The saved Claude account registry is unreadable; no account files were changed',
      );
    }
  }

  private writeRegistry(registry: Registry): void {
    mkdirSync(this.dataDir, { recursive: true });
    this.writePrivate(
      path.join(this.dataDir, CLAUDE_REGISTRY),
      `${JSON.stringify(registry, null, 2)}\n`,
    );
  }

  private writePrivate(file: string, contents: string): void {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      chmodSync(temp, 0o600);
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
  }
}

export function normalizeClaudeAuth(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (
    obj.claudeAiOauth &&
    typeof obj.claudeAiOauth === 'object' &&
    !Array.isArray(obj.claudeAiOauth)
  ) {
    const oauth = obj.claudeAiOauth as Record<string, unknown>;
    if (
      (typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0) ||
      (typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0)
    ) {
      return { claudeAiOauth: oauth };
    }
  }
  if (
    (typeof obj.accessToken === 'string' && obj.accessToken.length > 0) ||
    (typeof obj.refreshToken === 'string' && obj.refreshToken.length > 0)
  ) {
    return { claudeAiOauth: obj };
  }
  if (typeof obj.ANTHROPIC_API_KEY === 'string' && obj.ANTHROPIC_API_KEY.trim().length > 0) {
    return { ANTHROPIC_API_KEY: obj.ANTHROPIC_API_KEY.trim() };
  }
  return null;
}

export function extractClaudeAuthMeta(
  normalized: Record<string, unknown>,
  raw?: unknown,
): { email: string | null; plan: string | null } {
  const rawObj =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const oauth =
    normalized.claudeAiOauth &&
    typeof normalized.claudeAiOauth === 'object' &&
    !Array.isArray(normalized.claudeAiOauth)
      ? (normalized.claudeAiOauth as Record<string, unknown>)
      : {};
  const email =
    typeof rawObj.email === 'string' && rawObj.email.trim()
      ? rawObj.email.trim()
      : typeof oauth.email === 'string' && oauth.email.trim()
        ? oauth.email.trim()
        : null;
  const plan =
    typeof oauth.subscriptionType === 'string' && oauth.subscriptionType.trim()
      ? oauth.subscriptionType.trim()
      : typeof rawObj.plan === 'string' && rawObj.plan.trim()
        ? rawObj.plan.trim()
        : typeof normalized.ANTHROPIC_API_KEY === 'string'
          ? 'api_key'
          : null;
  return { email, plan };
}
