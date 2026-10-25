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
}
export interface NativeAccountsState {
  available: boolean;
  accounts: NativeAccount[];
  defaultAccount?: NativeAccount | null;
}
