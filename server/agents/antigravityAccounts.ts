import { config } from '../config.js';
import { NativeAntigravityAccounts } from './antigravityNative.js';
import { z } from 'zod';
import type { AntigravityAccountsState } from '../../shared/antigravityAccounts.js';

const windowSchema = z.object({ remaining_percent: z.number().min(0).max(100) }).passthrough();
const accountSchema = z.object({
  id: z.string().regex(/^acct_[a-zA-Z0-9_-]+$/),
  email: z.string().max(320).nullish(),
  alias: z.string().max(160).nullish(),
  active: z.boolean().optional(),
  plan: z.string().max(100).nullable().optional(),
  usage: z
    .object({
      five_hour: windowSchema.nullish(),
      weekly: windowSchema.nullish(),
      updated_at: z.string().optional(),
    })
    .nullish(),
  usage_error: z.unknown().optional(),
});
export function parseAntigravityAccounts(raw: string): AntigravityAccountsState {
  const result = z
    .object({
      schema_version: z.literal(1),
      command: z.literal('list'),
      data: z.object({ accounts: z.array(accountSchema).max(200) }),
    })
    .parse(JSON.parse(raw));
  return {
    available: true,
    accounts: result.data.accounts.map((a) => ({
      id: a.id,
      name: a.alias || a.email || a.id,
      email: a.email || '',
      active: a.active === true,
      plan: a.plan ?? null,
      usage: {
        fiveHour:
          !a.usage_error && a.usage?.five_hour ? 100 - a.usage.five_hour.remaining_percent : null,
        weekly: !a.usage_error && a.usage?.weekly ? 100 - a.usage.weekly.remaining_percent : null,
        updatedAt: !a.usage_error ? (a.usage?.updated_at ?? null) : null,
      },
    })),
  };
}
const native = new NativeAntigravityAccounts(config.dataDir);
export const antigravityAccounts = (refresh = false) =>
  refresh ? native.refresh() : native.state(true);
export const switchAntigravityAccount = (id: string) => native.switch(id);
export const saveAntigravityAccount = (name?: string) => native.saveCurrent(name);
export const importAntigravityAccount = (raw: string, name?: string) => native.import(raw, name);
export const refreshAntigravityAccount = (id: string) => native.refresh(id);
export const renameAntigravityAccount = (id: string, name: string) => native.rename(id, name);
export const removeAntigravityAccount = (id: string) => native.remove(id);
