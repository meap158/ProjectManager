import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { AntigravityAccountsState } from '../../shared/antigravityAccounts.js';
import { resolveArgv } from './resolve.js';

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
async function run(args: string[]): Promise<string> {
  const argv = await resolveArgv(['agy-auth', ...args]);
  return new Promise((resolve, reject) =>
    execFile(
      argv[0]!,
      argv.slice(1),
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, AGY_AUTH_NO_UPDATE_CHECK: '1' },
      },
      (error, stdout) =>
        error
          ? reject(
              Object.assign(
                new Error('Antigravity account operation failed. Check agy-auth locally.'),
                { code: error.code },
              ),
            )
          : resolve(stdout),
    ),
  );
}
export async function antigravityAccounts(refresh = false): Promise<AntigravityAccountsState> {
  try {
    await resolveArgv(['agy-auth']);
  } catch {
    return { available: false, accounts: [] };
  }
  try {
    return parseAntigravityAccounts(
      await run(['list', '--json', '--no-sync', ...(refresh ? [] : ['--no-usage'])]),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { available: false, accounts: [] };
    throw new Error('Unable to read Antigravity accounts. Check agy-auth locally.', {
      cause: error,
    });
  }
}
let switching = false;
export async function switchAntigravityAccount(id: string): Promise<AntigravityAccountsState> {
  if (switching) throw new Error('An Antigravity account switch is already in progress.');
  switching = true;
  try {
    const before = await antigravityAccounts();
    if (!before.accounts.some((a) => a.id === id))
      throw new Error('Antigravity account not found.');
    const result = JSON.parse(await run(['switch', id, '--json'])) as {
      schema_version?: number;
      command?: string;
      error?: unknown;
    };
    if (result.schema_version !== 1 || result.command !== 'switch' || result.error)
      throw new Error('Antigravity account switch failed.');
    const after = await antigravityAccounts();
    if (!after.accounts.some((a) => a.id === id && a.active))
      throw new Error('Account switch could not be verified. Refresh accounts before retrying.');
    return after;
  } finally {
    switching = false;
  }
}
