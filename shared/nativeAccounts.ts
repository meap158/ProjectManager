import type { ProviderLimits } from './limits.js';

/** Metadata only: native credentials never cross the HTTP boundary. */
export interface NativeAccount {
  id: string;
  name: string;
  email: string;
  active: boolean;
  plan: string | null;
  usage: { fiveHour: number | null; weekly: number | null; updatedAt: string | null };
  limits?: ProviderLimits | null;
  usageStatus?: 'fresh' | 'stale' | 'expired' | 'unavailable' | 'not_loaded';
  /**
   * Grok only (PM-523): the access token has expired but the saved login carries a refresh
   * token, so the CLI renews it when this account is switched in.
   */
  renewable?: boolean;
  /** What the usage check found when there is no percentage to show (PM-525). */
  usageNote?: string;
  /** Grok only (PM-531): false when the owner left this saved login out of automatic switching. */
  autoSwitchEligible?: boolean;
}
export interface NativeAccountsState {
  /** Safe explanation when the live login is absent or unreadable; saved profiles remain usable. */
  authNote?: string;
  available: boolean;
  accounts: NativeAccount[];
  defaultAccount?: NativeAccount | null;
  /** Grok only: automatic rotation when the login in use runs out of credits (PM-412). */
  autoSwitch?: boolean;
}
