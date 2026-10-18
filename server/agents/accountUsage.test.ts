import { expect, it, vi } from 'vitest';
import { parseAccountLimits, readCodexAccountUsage } from './accountUsage.js';
import { resolveArgv } from './resolve.js';
vi.mock('./resolve.js', () => ({ resolveArgv: vi.fn() }));

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
