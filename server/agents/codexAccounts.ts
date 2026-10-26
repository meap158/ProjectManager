import {
  closeSync,
  openSync,
  readSync,
  writeSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { getSetting, setSetting } from '../store.js';
import type { CodexAccount, CodexAccountsState } from '../../shared/types.js';
import { claudeLimits } from './limits.js';
import { readCodexAccountUsage, type AccountUsageResult } from './accountUsage.js';
import {
  ACCOUNT_USAGE_MAX_AGE_MS,
  bySwitchQuota,
  switchQuota,
  usageIsFresh,
  verifiedRemainingQuota,
} from './accountPolicy.js';

const REGISTRY = 'codex-accounts.json';
const ACTIVE_KEY = 'codex-accounts-active';
const AUTO_SWITCH_KEY = 'codex-accounts-auto-switch';
/** Last usage read per account home (limits and times only, never credentials). */
const USAGE_KEY = 'codex-accounts-usage-identity-v2';
/** Opening the accounts panel re-reads usage older than this, in the background. */
export const USAGE_MAX_AGE_MS = ACCOUNT_USAGE_MAX_AGE_MS;
const MAX_AUTH_BYTES = 1024 * 1024;

interface StoredAccount {
  autoSwitchEligible?: boolean;
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
  private readonly usage = new Map<string, AccountUsageResult & { owner: string }>();
  private usageIdentity(home: string): string {
    const file = path.join(home, 'auth.json');
    try {
      const identity = this.loginIdentity(file);
      return createHash('sha256')
        .update(identity ? JSON.stringify(identity) : readFileSync(file))
        .digest('hex');
    } catch {
      return '';
    }
  }
  private knownUsage(home: string) {
    const result = this.usage.get(home);
    return result?.owner === this.usageIdentity(home) ? result : undefined;
  }
  private refreshingUsage: Promise<CodexAccountsState> | null = null;
  private credentialRevision = 0;

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
    const firstByIdentity = new Map<string, string>();
    const sources = new Map<string, string>();
    for (const home of this.usageHomes()) {
      const identity = this.usageIdentity(home);
      if (identity && !firstByIdentity.has(identity)) firstByIdentity.set(identity, home);
      sources.set(home, (identity && firstByIdentity.get(identity)) || home);
    }
    // The saved copy of the login in ~/.codex is never started: its refresh token is stale once
    // Codex refreshes the default one (PM-243), and using it could sign the default out.
    const inUse = this.defaultMatch();
    if (inUse && sources.has(this.home(inUse))) sources.set(this.home(inUse), this.defaultHome());
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
            const owner = this.usageIdentity(home);
            const revision = this.credentialRevision;
            const result = await reader(home);
            if (
              !owner ||
              revision !== this.credentialRevision ||
              owner !== this.usageIdentity(home)
            )
              return;
            // A failed read keeps the last known numbers, labelled with the failure.
            const known = this.knownUsage(home)?.limits;
            this.usage.set(home, {
              ...(result.limits || !known ? result : { ...result, limits: known }),
              owner,
            });
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

  async refreshAccountUsage(
    id: string,
    reader = readCodexAccountUsage,
  ): Promise<CodexAccountsState> {
    const home = id === 'default' ? this.defaultHome() : this.home(id);
    if (id !== 'default' && !this.account(id))
      throw new CodexAccountError(404, 'Codex account not found');
    if (this.refreshingUsage) await this.refreshingUsage;
    const source = this.usageSources().get(home) ?? home;
    return this.refreshUsage(reader, (candidate) => candidate === source);
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
      const known = this.knownUsage(home);
      return (
        !known ||
        !(now - Date.parse(known.checkedAt) < maxAgeMs) ||
        !!known.limits?.windows.some(
          (w) =>
            w.resetsAt &&
            Date.parse(w.resetsAt) <= now &&
            Date.parse(w.resetsAt) > Date.parse(known.checkedAt),
        )
      );
    };
    if (!this.usageReadHomes().some(stale)) return;
    void this.refreshUsage(reader, stale).catch((error: Error) => {
      console.error('[codex-accounts] usage refresh:', error);
    });
  }

  private loadUsage(): void {
    const saved =
      getSetting<Record<string, AccountUsageResult & { owner: string }>>(this.db, USAGE_KEY) ?? {};
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
    const own = this.knownUsage(home);
    const current = this.knownUsage(source) ?? own;
    // Conversation rollouts can belong to another login after switching or history carry.
    const limits = current?.limits ?? null;
    const usageStatus =
      current?.status === 'fresh' && !usageIsFresh(current.checkedAt, now)
        ? ('stale' as const)
        : (current?.status ?? (limits ? ('stale' as const) : ('not_loaded' as const)));
    return { limits, usageStatus, usageCheckedAt: limits?.asOf ?? current?.checkedAt ?? null };
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
    // The account in use is whichever saved login ~/.codex/auth.json holds (also after a manual
    // `codex login`), not a remembered choice.
    const activeProfileId = this.defaultMatch();
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
        autoSwitchEligible: account.autoSwitchEligible !== false,
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

  /**
   * Makes a saved login the default one, as `codex login` with that account would: its auth.json
   * becomes ~/.codex/auth.json, and every Codex CLI runs there and resumes its conversation
   * natively (PM-243). The login it replaces is kept first: written back to its saved profile
   * (Codex rotates refresh tokens in the default home, so that copy is the fresh one), or saved
   * as a new profile when it was never saved.
   */
  setActive(id: string | null): CodexAccountsState {
    const normalized = id === 'default' ? null : id;
    if (normalized !== null && !this.account(normalized))
      throw new CodexAccountError(404, 'Codex account not found');
    if (normalized !== null) this.makeDefault(normalized);
    setSetting(this.db, ACTIVE_KEY, normalized);
    const registryFile = path.join(this.dataDir, REGISTRY);
    if (existsSync(registryFile) || normalized !== null) {
      const registry = this.readRegistry();
      this.writeRegistry({ ...registry, activeProfileId: normalized });
    }
    return this.state();
  }

  private makeDefault(id: string): void {
    const source = path.join(this.home(id), 'auth.json');
    if (!existsSync(source))
      throw new CodexAccountError(
        404,
        'This saved login has no auth.json; save or import it again',
      );
    const defaultHome = this.defaultHome();
    const defaultFile = path.join(defaultHome, 'auth.json');
    const current = this.defaultMatch();
    if (current === id) return; // Already the default login.
    this.credentialRevision++;
    const leavingUsage = this.knownUsage(defaultHome);
    const arrivingUsage = this.knownUsage(this.home(id));
    let leaving = current;
    if (existsSync(defaultFile)) {
      if (current) {
        const saved = path.join(this.home(current), 'auth.json');
        if (this.lastRefresh(defaultFile) >= this.lastRefresh(saved))
          this.writePrivate(saved, readFileSync(defaultFile, 'utf8'));
      } else {
        const email = this.readAuthMeta(defaultFile).email;
        const state = this.importAccount(
          email ?? 'Earlier default login',
          readFileSync(defaultFile, 'utf8'),
        );
        leaving = state.accounts.at(-1)?.id ?? null;
      }
    }
    mkdirSync(defaultHome, { recursive: true, mode: 0o700 });
    this.writePrivate(defaultFile, readFileSync(source, 'utf8'));
    // Usage is cached per folder: ~/.codex's reading belongs to the login leaving it, and the
    // arriving login brings its own last reading. Otherwise the account just switched to showed
    // the previous account's usage until the next refresh.
    if (leaving && leavingUsage) this.usage.set(this.home(leaving), leavingUsage);
    if (arrivingUsage) this.usage.set(defaultHome, arrivingUsage);
    else this.usage.delete(defaultHome);
    this.saveUsage();
  }

  /** The saved profile holding the login in ~/.codex/auth.json (ChatGPT account, else email). */
  defaultMatch(): string | null {
    const defaultFile = path.join(this.defaultHome(), 'auth.json');
    if (!existsSync(defaultFile)) return null;
    const accounts = this.readRegistry().accounts;
    // Just switched: the default is a byte-for-byte copy of the saved login.
    const raw = readFileSync(defaultFile);
    for (const account of accounts) {
      const file = path.join(this.home(account.id), 'auth.json');
      if (existsSync(file) && readFileSync(file).equals(raw)) return account.id;
    }
    // Codex refreshed the tokens since: the same ChatGPT account and email.
    const current = this.loginIdentity(defaultFile);
    if (!current) return null;
    for (const account of accounts) {
      const identity = this.loginIdentity(path.join(this.home(account.id), 'auth.json'));
      const saved = identity && {
        account: identity.account,
        email: identity.email ?? account.email?.toLowerCase() ?? null,
      };
      if (
        saved &&
        (current.account && saved.account
          ? current.account === saved.account && current.email === saved.email
          : current.email !== null && current.email === saved.email)
      )
        return account.id;
    }
    return null;
  }

  private loginIdentity(file: string): { account: string | null; email: string | null } | null {
    if (!existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      const auth = normalizeCodexAuth(raw);
      if (!auth) return null;
      const tokens = (auth.tokens ?? {}) as Record<string, unknown>;
      const account = typeof tokens.account_id === 'string' ? tokens.account_id : null;
      const email = extractCodexAuthMeta(auth, raw).email?.toLowerCase() ?? null;
      return account || email ? { account, email } : null;
    } catch {
      return null;
    }
  }

  /** When Codex last refreshed this login's tokens (0 when unknown). */
  private lastRefresh(file: string): number {
    try {
      const value = (JSON.parse(readFileSync(file, 'utf8')) as { last_refresh?: unknown })
        .last_refresh;
      const time = typeof value === 'string' ? Date.parse(value) : NaN;
      return Number.isFinite(time) ? time : 0;
    } catch {
      return 0;
    }
  }

  setAutoSwitchEligible(id: string, eligible: boolean): CodexAccountsState {
    const registry = this.readRegistry();
    if (!registry.accounts.some((account) => account.id === id))
      throw new CodexAccountError(404, 'Codex account not found');
    this.writeRegistry({
      ...registry,
      accounts: registry.accounts.map((account) =>
        account.id === id ? { ...account, autoSwitchEligible: eligible } : account,
      ),
    });
    return this.state();
  }

  /**
   * Save the order Settings shows (Reorder accounts), which auto-switch uses to break a tie.
   * Unknown ids are ignored and accounts left out keep their place after the listed ones.
   */
  setOrder(ids: readonly string[]): CodexAccountsState {
    const registry = this.readRegistry();
    const rank = (id: string) => (ids.includes(id) ? ids.indexOf(id) : ids.length);
    this.writeRegistry({
      ...registry,
      accounts: [...registry.accounts].sort((a, b) => rank(a.id) - rank(b.id)),
    });
    return this.state();
  }

  /** The auto-switch setting alone: `state()` also reads every login and usage reading. */
  autoSwitchEnabled(): boolean {
    return getSetting<boolean>(this.db, AUTO_SWITCH_KEY) ?? true;
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
    // Already saved: switching writes the fresh tokens back to that profile, no second copy.
    if (this.defaultMatch()) return this.state();
    // The login stays in ~/.codex, where every Codex CLI runs (PM-243); the copy is what a later
    // switch back restores. Don't run `codex logout` there: it would revoke the saved copy too.
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

  /** Where Codex CLIs run (never a saved profile's stored copy: its token may be stale). */
  selectedHome(): string {
    return this.runHome();
  }

  selectedId(): string {
    return this.defaultMatch() ?? 'default';
  }

  /** A login and the folder its credentials are stored in (CLIs run in `runHome()`). */
  profile(id: string): { id: string; name: string; home: string } {
    if (id === 'default') return { id, name: 'Default Codex account', home: this.defaultHome() };
    const account = this.account(id);
    if (!account) throw new CodexAccountError(404, 'Codex account not found');
    const home = this.home(account.id);
    this.syncConfigToml(home);
    return { id: account.id, name: account.name, home };
  }

  /**
   * Where every Codex CLI runs: the default CODEX_HOME, whatever the login (PM-243). Switching
   * copies a saved login into it (`setActive`), so conversations stay in one folder and resume
   * natively, exactly as after a manual `codex login`.
   */
  runHome(): string {
    return this.defaultHome();
  }

  /** The login in use, with the folder CLIs run in. */
  selectedProfile(): { id: string; name: string; home: string } {
    return { ...this.profile(this.selectedId()), home: this.runHome() };
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
   * Requires verified current-account exhaustion, then picks the untried account with the most
   * quota (`bySwitchQuota`: 5-hour, then weekly, then list order). Unknown, stale or reset-due
   * readings never authorize a switch, and with no candidate left it stays put.
   *
   * Exhausted means a fresh verified zero. `limitShown` says a session or run printed the CLI's
   * own usage-limit message: a second signal, so a fresh verified reading with 5% or less left is
   * then enough, which covers a meter that lags the CLI. An unknown or stale reading authorizes
   * nothing.
   */
  nextUnused(
    currentKey: string | null,
    tried: readonly string[],
    now = Date.now(),
    limitShown = false,
  ): { id: string; name: string; home: string } | null {
    // A manual switch during an awaited refresh invalidates the caller's original selection.
    if ((currentKey ?? 'default') !== (this.defaultMatch() ?? 'default')) return null;
    // "Default" is just the login in use; once it is a saved profile, rotate over profiles only.
    const accounts = [
      ...(this.defaultMatch()
        ? []
        : [{ id: 'default', name: 'Default Codex account', home: this.defaultHome() }]),
      ...this.readRegistry()
        .accounts.filter((account) => account.autoSwitchEligible !== false)
        .map((account) => ({
          id: account.id,
          name: account.name,
          home: this.home(account.id),
        })),
    ];
    const sources = this.usageSources();
    const reading = (home: string) => this.knownUsage(sources.get(home) ?? home);
    const currentHome =
      currentKey && currentKey !== 'default' ? this.home(currentKey) : this.defaultHome();
    const left = verifiedRemainingQuota(reading(currentHome), now);
    if (left === null || left > (limitShown ? 5 : 0)) return null;
    const ranked = accounts
      .filter((a) => a.id !== currentKey && !tried.includes(a.id))
      .map((account) => ({ account, quota: switchQuota(reading(account.home), now) }))
      .filter(
        (
          candidate,
        ): candidate is {
          account: (typeof accounts)[number];
          quota: NonNullable<ReturnType<typeof switchQuota>>;
        } => candidate.quota !== null && candidate.quota.usable >= 1,
      )
      .sort((a, b) => bySwitchQuota(a.quota, b.quota));
    const chosen = ranked[0]?.account;
    if (!chosen) return null;
    if (chosen.id !== 'default') this.syncConfigToml(chosen.home);
    return chosen;
  }

  /**
   * Whether an account auto-switch already left has quota again: a verified reading taken after
   * `since` shows some left (its window reset). Lets the rotation come back to it instead of
   * stopping for good once every account has been tried.
   */
  quotaRecovered(
    id: string,
    since: number,
    now = Date.now(),
    sources: Map<string, string> = this.usageSources(),
  ): boolean {
    const home = id === 'default' ? this.defaultHome() : this.account(id) ? this.home(id) : null;
    if (!home) return false;
    const reading = this.knownUsage(sources.get(home) ?? home);
    const checked = Date.parse(reading?.checkedAt ?? '');
    return checked > since && (verifiedRemainingQuota(reading, now) ?? 0) > 0;
  }

  /** The accounts among `tried` whose quota is back (`quotaRecovered`), reading logins once. */
  recoveredAccounts(tried: ReadonlyMap<string, number>, now = Date.now()): string[] {
    if (!tried.size) return [];
    const sources = this.usageSources();
    return [...tried]
      .filter(([id, since]) => this.quotaRecovered(id, since, now, sources))
      .map(([id]) => id);
  }

  /** Keep the native resume picker independent of the selected credential. */
  syncResumeHistory(targetHome: string): void {
    const homes = [this.defaultHome(), ...this.readRegistry().accounts.map((a) => this.home(a.id))];
    const newest = new Map<string, { home: string; file: string; time: number; size: number }>();
    // What the target already holds, found by this one scan (not a tree walk per conversation).
    const held = new Map<string, { time: number; size: number }>();
    const index = new Map<string, { line: string; time: number }>();
    for (const home of homes) {
      const sessions = path.join(home, 'sessions');
      if (existsSync(sessions)) {
        for (const relative of readdirSync(sessions, { recursive: true }).map(String)) {
          const match = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/i.exec(path.basename(relative));
          if (!match) continue;
          const file = path.join(sessions, relative);
          const stat = statSync(file);
          const time = stat.mtimeMs;
          const id = match[1]!;
          if (normalPath(home) === normalPath(targetHome)) {
            const was = held.get(id);
            held.set(id, {
              time: Math.max(was?.time ?? 0, time),
              size: Math.max(was?.size ?? 0, stat.size),
            });
          }
          if (!newest.has(id) || newest.get(id)!.time < time)
            newest.set(id, { home, file, time, size: stat.size });
        }
      }
      const indexFile = path.join(home, 'session_index.jsonl');
      if (!existsSync(indexFile)) continue;
      for (const line of readFileSync(indexFile, 'utf8').split('\n').filter(Boolean)) {
        try {
          const entry = JSON.parse(line) as { id?: string; updated_at?: string };
          if (!entry.id) continue;
          const time = Date.parse(entry.updated_at ?? '') || 0;
          if (!index.has(entry.id) || index.get(entry.id)!.time <= time)
            index.set(entry.id, { line, time });
        } catch {
          /* Ignore an incomplete append; retain all other records. */
        }
      }
    }
    for (const [id, source] of newest) {
      if (normalPath(source.home) === normalPath(targetHome)) continue;
      // Nothing to copy when the target is as recent, or already holds as much: a copy is the
      // original minus its sealed reasoning, so it is never larger. Judging by time alone made a
      // profile's copy look newer than the original in another home and copied it back over it
      // (GBs, synchronously) when switching to Default.
      const have = held.get(id);
      if (have && (have.time >= source.time || have.size >= source.size)) continue;
      if (!this.carryRollout(source.file, source.home, targetHome)) {
        this.saveCopyState();
        throw new CodexAccountError(
          409,
          'Could not preserve resume history; account was not switched',
        );
      }
    }
    this.saveCopyState();
    if (index.size)
      this.writePrivate(
        path.join(targetHome, 'session_index.jsonl'),
        [...index.values()]
          .sort((a, b) => a.time - b.time)
          .map((item) => item.line)
          .join('\n') + '\n',
      );
  }

  /** The rollout file of conversation `id` inside a Codex home, or null. */
  findRollout(home: string, id: string): string | null {
    if (!/^[0-9a-f-]{16,}$/i.test(id)) return null;
    const root = path.join(home, 'sessions');
    if (!existsSync(root)) return null;
    try {
      const found = readdirSync(root, { recursive: true })
        .map(String)
        .filter(
          (name) => path.basename(name).startsWith('rollout-') && name.endsWith(`-${id}.jsonl`),
        )
        .sort()
        .pop();
      return found ? path.join(root, found) : null;
    } catch {
      return null;
    }
  }

  /**
   * Moves a conversation onto another login (PM-188) so `codex resume <id>` continues it there.
   * The rollout is copied under the same relative path with its encrypted reasoning items left
   * out: those are sealed to the account that produced them, and the other login cannot read
   * them. Messages, tool calls and their outputs, the parts the model works from, are kept. The
   * previous home keeps its own copy. Returns false when there is nothing to carry, in which
   * case the caller starts a new conversation.
   */
  carryConversation(fromHome: string, toHome: string, id: string): boolean {
    // Same folder (a login change in ~/.codex): resumable when the conversation is there.
    if (normalPath(fromHome) === normalPath(toHome)) return this.findRollout(fromHome, id) !== null;
    const source = this.findRollout(fromHome, id);
    if (!source) return false;
    const carried = this.carryRollout(source, fromHome, toHome);
    this.saveCopyState();
    return carried;
  }

  private carryRollout(source: string, fromHome: string, toHome: string): boolean {
    try {
      if (toHome !== this.defaultHome()) this.syncConfigToml(toHome);
      const dest = path.join(toHome, path.relative(fromHome, source));
      mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      // The target already holds at least this much of the conversation (a copy never outgrows
      // its original): leave it. Otherwise switching a session back to Default would overwrite
      // the original rollout in the default home with this profile's filtered copy.
      if (existsSync(dest) && statSync(dest).size >= statSync(source).size) return true;
      this.filteredCopy(source, dest);
      // A copy is dated like its original, so it never looks newer than the thing it came from.
      const origin = statSync(source);
      utimesSync(dest, origin.atime, origin.mtime);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Copies a rollout without its sealed reasoning records. Rollouts only ever grow (one JSON
   * record per line, several GB for long sessions), so a copy made before is brought up to date
   * by filtering just the lines added since: re-copying a live multi-GB rollout on every account
   * switch froze the server. The point reached is remembered per destination and trusted only
   * while the destination still has the size we left it with; otherwise it is copied afresh.
   */
  private filteredCopy(source: string, dest: string): void {
    const state = this.copyState();
    const key = normalPath(dest);
    const known = state[key];
    const sourceSize = statSync(source).size;
    let destSize = -1;
    try {
      destSize = statSync(dest).size;
    } catch {
      // Not copied yet.
    }
    const append =
      known !== undefined &&
      known.source === normalPath(source) &&
      known.destSize === destSize &&
      known.offset <= sourceSize;
    if (append && known.offset === sourceSize) return;
    // Rollouts can exceed the JS string limit. Copy bounded chunks and filter
    // sealed reasoning records without reading the whole history into memory.
    const input = openSync(source, 'r');
    const temporary = append ? null : `${dest}.${randomUUID()}.tmp`;
    let output: number | undefined;
    try {
      output = openSync(temporary ?? dest, append ? 'a' : 'wx', 0o600);
      const buffer = Buffer.alloc(1024 * 1024);
      let pending = Buffer.alloc(0);
      let position = append ? known.offset : 0;
      let written = append ? destSize : 0;
      const writeLine = (line: Buffer) => {
        // JSON record type is near the beginning, even for huge tool outputs.
        const prefix = line.subarray(0, 2048).toString('utf8');
        if (/"type"\s*:\s*"response_item"/.test(prefix) && /"type"\s*:\s*"reasoning"/.test(prefix))
          return;
        let offset = 0;
        while (offset < line.length)
          offset += writeSync(output!, line, offset, line.length - offset);
        written += line.length;
      };
      let length: number;
      while ((length = readSync(input, buffer, 0, buffer.length, position)) > 0) {
        position += length;
        const chunk = pending.length
          ? Buffer.concat([pending, buffer.subarray(0, length)])
          : buffer.subarray(0, length);
        let start = 0;
        for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
          writeLine(chunk.subarray(start, end + 1));
          start = end + 1;
        }
        pending = Buffer.from(chunk.subarray(start));
      }
      if (pending.length) writeLine(pending);
      closeSync(output);
      output = undefined;
      if (temporary) renameSync(temporary, dest);
      // A last line without its newline may still be growing: no resume point then, so the next
      // sync copies afresh rather than appending after half a line.
      if (pending.length) delete state[key];
      else state[key] = { source: normalPath(source), offset: position, destSize: written };
    } finally {
      closeSync(input);
      if (output !== undefined) closeSync(output);
      if (temporary) rmSync(temporary, { force: true });
    }
  }

  private copyStateCache: Record<
    string,
    { source: string; offset: number; destSize: number }
  > | null = null;

  private copyState() {
    if (this.copyStateCache) return this.copyStateCache;
    try {
      const raw = JSON.parse(
        readFileSync(path.join(this.dataDir, 'codex-resume-sync.json'), 'utf8'),
      ) as unknown;
      this.copyStateCache = raw && typeof raw === 'object' ? (raw as never) : {};
    } catch {
      this.copyStateCache = {};
    }
    return this.copyStateCache!;
  }

  private saveCopyState(): void {
    if (!this.copyStateCache) return;
    try {
      this.writePrivate(
        path.join(this.dataDir, 'codex-resume-sync.json'),
        JSON.stringify(this.copyStateCache),
      );
    } catch {
      // Losing it only means the next sync copies afresh.
    }
  }

  /**
   * Copies a rollout into another Codex home as is. Use `carryConversation` to continue a thread
   * on a different ChatGPT account: a straight copy keeps reasoning items sealed to the old one.
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
  private sameCredential(left: string, right: string): boolean {
    try {
      const a = normalizeClaudeAuth(JSON.parse(readFileSync(left, 'utf8')));
      const b = normalizeClaudeAuth(JSON.parse(readFileSync(right, 'utf8')));
      if (!a || !b) return false;
      const x = a.claudeAiOauth as Record<string, unknown> | undefined;
      const y = b.claudeAiOauth as Record<string, unknown> | undefined;
      if (x && y)
        return ['accessToken', 'refreshToken'].some(
          (key) => typeof x[key] === 'string' && !!x[key] && x[key] === y[key],
        );
      return typeof a.ANTHROPIC_API_KEY === 'string' && a.ANTHROPIC_API_KEY === b.ANTHROPIC_API_KEY;
    } catch {
      return false;
    }
  }

  constructor(
    private readonly dataDir: string,
    private readonly db: Db,
  ) {
    this.root = path.join(dataDir, 'claude-accounts');
  }

  state(now = Date.now()): CodexAccountsState {
    const registry = this.readRegistry();
    const saved = getSetting<string | null>(this.db, CLAUDE_ACTIVE_KEY) ?? null;
    const activeProfileId =
      saved &&
      registry.accounts.some((account) => account.id === saved) &&
      this.sameCredential(
        path.join(this.defaultHome(), '.credentials.json'),
        path.join(this.home(saved), '.credentials.json'),
      )
        ? saved
        : null;
    const autoSwitch = this.autoSwitchEnabled();
    const defCredsFile = this.defaultBackupCredsFile();
    const liveCredsFile = path.join(this.defaultHome(), '.credentials.json');
    const sourceCredsFile = activeProfileId ? defCredsFile : liveCredsFile;
    const defMeta = this.readAuthMeta(sourceCredsFile, activeProfileId === null);
    const defaultAccount = {
      available: existsSync(sourceCredsFile),
      email: defMeta.email,
      plan: defMeta.plan,
      ...this.accountUsage(sourceCredsFile, now),
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
        ...this.accountUsage(
          account.id === activeProfileId ? liveCredsFile : path.join(home, '.credentials.json'),
          now,
        ),
      };
    });
    return { accounts, activeProfileId, autoSwitch, defaultAccount };
  }

  private accountUsage(
    file: string,
    now: number,
  ): Pick<CodexAccount, 'limits' | 'usageStatus' | 'usageCheckedAt'> {
    try {
      const credentials = JSON.parse(readFileSync(file, 'utf8')) as {
        claudeAiOauth?: { accessToken?: string };
      };
      const token = credentials.claudeAiOauth?.accessToken;
      if (!token) return { limits: null, usageStatus: 'unavailable', usageCheckedAt: null };
      const identity = createHash('sha256').update(token).digest('hex');
      const limits = claudeLimits(path.join(this.dataDir, 'claude-account-usage', identity), now);
      return {
        limits,
        usageCheckedAt: limits?.asOf ?? null,
        usageStatus: limits ? (!usageIsFresh(limits.asOf, now) ? 'stale' : 'fresh') : 'not_loaded',
      };
    } catch {
      return { limits: null, usageStatus: 'unavailable', usageCheckedAt: null };
    }
  }

  setActive(id: string | null): CodexAccountsState {
    const normalized = id === 'default' ? null : id;
    const account = normalized !== null ? this.account(normalized) : undefined;
    if (normalized !== null && !account)
      throw new CodexAccountError(404, 'Claude account not found');

    const currentActive = this.state().activeProfileId;
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

  /** Off until chosen: Claude rotation restarts sessions, so it is never a surprise. */
  autoSwitchEnabled(): boolean {
    return getSetting<boolean>(this.db, CLAUDE_AUTO_SWITCH_KEY) === true;
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
      // Removing a saved copy must not sign out or replace the current CLI login.
      setSetting(this.db, CLAUDE_ACTIVE_KEY, null);
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
