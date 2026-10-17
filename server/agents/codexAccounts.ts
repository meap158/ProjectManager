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

const REGISTRY = 'codex-accounts.json';
const ACTIVE_KEY = 'codex-accounts-active';
const AUTO_SWITCH_KEY = 'codex-accounts-auto-switch';
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
  private readonly root: string;

  constructor(
    private readonly dataDir: string,
    private readonly db: Db,
  ) {
    this.root = path.join(dataDir, 'codex-accounts');
  }

  state(now = Date.now()): CodexAccountsState {
    const registry = this.readRegistry();
    const saved = getSetting<string | null>(this.db, ACTIVE_KEY) ?? null;
    const activeProfileId =
      saved && registry.accounts.some((account) => account.id === saved) ? saved : null;
    const autoSwitch = getSetting<boolean>(this.db, AUTO_SWITCH_KEY) ?? true;
    const defHome = this.defaultHome();
    const defAuthFile = path.join(defHome, 'auth.json');
    const defMeta = this.readAuthMeta(defAuthFile);
    const defaultAccount = {
      available: existsSync(defAuthFile),
      email: defMeta.email,
      plan: defMeta.plan,
      limits: codexLimits(os.homedir(), defHome, now),
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
        limits: codexLimits(os.homedir(), home, now),
      };
    });
    return { accounts, activeProfileId, autoSwitch, defaultAccount };
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
    return this.importAccount(name.trim() || meta.email || 'Default login copy', raw);
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
    const saved = getSetting<string | null>(this.db, ACTIVE_KEY) ?? null;
    if (saved && this.account(saved)) return saved;
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

  /** Saved profiles authenticate from their own auth.json, not the machine keyring. */
  private ensureFileCredentialStore(configPath: string): void {
    const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    const line = 'cli_auth_credentials_store = "file"';
    const hasKey = /^[ \t]*cli_auth_credentials_store[ \t]*=/m.test(current);
    const next = hasKey
      ? current.replace(/^[ \t]*cli_auth_credentials_store[ \t]*=.*$/m, line)
      : `${current}${current.endsWith('\n') || current.length === 0 ? '' : '\n'}${line}\n`;
    if (next === current) return;
    mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    this.writePrivate(configPath, next.endsWith('\n') ? next : `${next}\n`);
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
