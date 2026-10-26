import { expect, it, vi } from 'vitest';
import { parseAccountLimits, readCodexAccountUsage } from './accountUsage.js';
import { resolveArgv } from './resolve.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('./resolve.js', () => ({ resolveArgv: vi.fn() }));

it('rejects a service account identity that differs from the requested credential file', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'pm-usage-identity-'));
  try {
    const payload = Buffer.from(JSON.stringify({ email: 'expected@example.com' })).toString(
      'base64url',
    );
    writeFileSync(
      path.join(home, 'auth.json'),
      JSON.stringify({ tokens: { id_token: `x.${payload}.x` } }),
    );
    const script = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;let n;while((n=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(m.method==='initialized')continue;const result=m.id===2?{account:{type:'chatgpt',email:'other@example.com'}}:{};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');}});`;
    vi.mocked(resolveArgv).mockResolvedValue([process.execPath, '-e', script]);
    expect(await readCodexAccountUsage(home)).toMatchObject({
      status: 'unavailable',
      limits: null,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it('parses current account windows and never turns missing or malformed data into zero usage', () => {
  const now = Date.parse('2026-10-18T00:00:00Z');
  expect(parseAccountLimits({ rateLimits: { primary: null } }, now)).toBeNull();
  expect(parseAccountLimits({ rateLimits: { primary: { usedPercent: 25 } } }, now)).toBeNull();
  const response = {
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1792300000 },
        secondary: { usedPercent: 70, windowDurationMins: 10080 },
      },
    },
  };
  expect(parseAccountLimits(response, now)?.windows.map((w) => w.usedPercent)).toEqual([25, 70]);
  expect(parseAccountLimits(response, now)?.asOf).toBe('2026-10-18T00:00:00.000Z');
  for (const resetsAt of ['tomorrow', NaN, Infinity, 1e100]) {
    expect(
      parseAccountLimits(
        { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt } } },
        now,
      ),
    ).toBeNull();
  }
  for (const usedPercent of [-1, 101, NaN, Infinity]) {
    expect(
      parseAccountLimits(
        {
          rateLimits: {
            primary: { usedPercent, windowDurationMins: 300 },
            secondary: response.rateLimitsByLimitId.codex.secondary,
          },
        },
        now,
      ),
    ).toBeNull();
  }
  expect(
    parseAccountLimits(
      {
        rateLimits: {
          primary: response.rateLimitsByLimitId.codex.primary,
          secondary: { usedPercent: 100 },
        },
      },
      now,
    ),
  ).toBeNull();
});

it('uses an isolated profile for only initialize/account reads, then terminates the helper', async () => {
  const script = `process.stdin.setEncoding('utf8'); let b=''; process.stdin.on('data',chunk=>{b+=chunk;let n;while((n=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(m.method==='initialized')continue;if(!['initialize','account/read','account/rateLimits/read'].includes(m.method))process.exit(3);let result={};if(m.method==='account/read')result={account:{type:'chatgpt'}};if(m.method==='account/rateLimits/read')result={rateLimits:{primary:{usedPercent:42,windowDurationMins:300}}};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');}});`;
  vi.mocked(resolveArgv).mockResolvedValue([process.execPath, '-e', script]);
  const before = process.env.CODEX_HOME;
  const result = await readCodexAccountUsage('isolated-test-profile');
  expect(result.status).toBe('fresh');
  expect(result.limits?.windows[0]?.usedPercent).toBe(42);
  expect(process.env.CODEX_HOME).toBe(before);
});
