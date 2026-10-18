import { spawn } from 'node:child_process';
import type { ProviderLimits, UsageWindow } from '../../shared/limits.js';
import { resolveArgv } from './resolve.js';
import { windowLabel } from './limits.js';

export interface AccountUsageResult {
  status: 'fresh' | 'expired' | 'unavailable' | 'unsupported';
  limits: ProviderLimits | null;
  checkedAt: string;
}

export function parseAccountLimits(result: unknown, now = Date.now()): ProviderLimits | null {
  if (!result || typeof result !== 'object') return null;
  const response = result as {
    rateLimits?: unknown;
    rateLimitsByLimitId?: Record<string, unknown>;
  };
  const bucket = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
  if (!bucket || typeof bucket !== 'object') return null;
  const windows: UsageWindow[] = [];
  for (const key of ['primary', 'secondary'] as const) {
    const w = (bucket as Record<string, unknown>)[key] as Record<string, unknown> | null;
    if (
      !w ||
      typeof w.usedPercent !== 'number' ||
      !Number.isFinite(w.usedPercent) ||
      typeof w.windowDurationMins !== 'number' ||
      !Number.isFinite(w.windowDurationMins) ||
      w.windowDurationMins <= 0
    )
      continue;
    const reset =
      typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt)
        ? new Date(w.resetsAt * 1000)
        : null;
    windows.push({
      label: windowLabel(w.windowDurationMins),
      windowMinutes: w.windowDurationMins,
      usedPercent: Math.max(0, Math.min(100, w.usedPercent)),
      resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null,
    });
  }
  return windows.length
    ? {
        providerId: 'codex',
        windows,
        asOf: new Date(now).toISOString(),
        source: 'Codex account service',
      }
    : null;
}

/** Read-only account RPC: never starts a thread/turn or changes the selected CLI account.
 * Protocol: https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt */
export async function readCodexAccountUsage(home: string): Promise<AccountUsageResult> {
  const checkedAt = new Date().toISOString();
  let argv: string[];
  try {
    argv = await resolveArgv([
      'codex',
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      'cli_auth_credentials_store="file"',
    ]);
  } catch {
    return { status: 'unavailable', limits: null, checkedAt };
  }
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      env: { ...process.env, CODEX_HOME: home },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let ended = false;
    let buffer = '';
    const done = (status: AccountUsageResult['status'], limits: ProviderLimits | null = null) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill();
      resolve({ status, limits, checkedAt });
    };
    const timer = setTimeout(() => done('unavailable'), 15000);
    const send = (value: unknown) => {
      if (!ended) child.stdin.write(JSON.stringify(value) + '\n');
    };
    child.on('error', () => done('unavailable'));
    child.on('exit', () => done('unavailable'));
    child.stdin.on('error', () => done('unavailable'));
    child.stdout.on('data', (bytes: Buffer) => {
      buffer += bytes.toString('utf8');
      if (buffer.length > 1024 * 1024) return done('unavailable');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0 && !ended) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: {
          id?: number;
          result?: { account?: { type?: string } | null };
          error?: { message?: string };
        };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.error) {
          // Return only a safe category. Raw RPC diagnostics can contain authentication detail.
          return done(
            /401|unauthori|expired|sign.?in|authenticat|log.?in/i.test(message.error.message ?? '')
              ? 'expired'
              : 'unavailable',
          );
        }
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/read', params: { refreshToken: false } });
        }
        if (message.id === 2) {
          const account = message.result?.account;
          if (!account) return done('expired');
          if (account.type !== 'chatgpt' && account.type !== 'chatgptAuthTokens')
            return done('unsupported');
          send({ id: 3, method: 'account/rateLimits/read' });
        }
        if (message.id === 3) {
          const limits = parseAccountLimits(message.result);
          done(limits ? 'fresh' : 'unavailable', limits);
        }
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'projectmanager', title: 'ProjectManager', version: '0.1.0' },
        capabilities: {},
      },
    });
  });
}
