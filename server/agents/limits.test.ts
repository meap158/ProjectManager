import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeLimits, codexLimits, lastCodexLimits, readLimits, windowLabel } from './limits.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const event = (timestamp: string, five: number, week: number, resets = 1_900_000_000) =>
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: five, window_minutes: 300, resets_at: resets },
        secondary: { used_percent: week, window_minutes: 10_080, resets_at: resets + 3600 },
      },
    },
  });

/** A fake $CODEX_HOME with one rollout per entry, newest last (by mtime). */
function codexHome(rollouts: { day: string; lines: string[] }[]): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'pm-codex-'));
  dirs.push(home);
  rollouts.forEach(({ day, lines }, i) => {
    const dir = path.join(home, 'sessions', ...day.split('/'));
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-${i}.jsonl`);
    writeFileSync(file, lines.join('\n') + '\n');
    const t = new Date(Date.UTC(2026, 9, 6, 10, i)).getTime() / 1000;
    utimesSync(file, t, t);
  });
  return home;
}

describe('Codex usage limits', () => {
  it('reads the 5-hour and weekly windows from the last report', () => {
    const found = lastCodexLimits(
      [
        '{"cut off mid-line',
        event('2026-10-06T10:00:00Z', 10, 50),
        event('2026-10-06T10:05:00Z', 23, 82),
      ].join('\n'),
    );
    expect(found?.asOf).toBe('2026-10-06T10:05:00.000Z');
    expect(found?.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ['5-hour', 23],
      ['Weekly', 82],
    ]);
    expect(found?.windows[0]!.resetsAt).toBe(new Date(1_900_000_000_000).toISOString());
  });

  it('takes the most recent report across parallel sessions, even far from a file end', () => {
    const home = codexHome([
      { day: '2026/10/05', lines: [event('2026-10-05T09:00:00Z', 5, 40)] },
      // Newest file by mtime, but its report is older than the next one's.
      { day: '2026/10/06', lines: [event('2026-10-06T09:00:00Z', 30, 70)] },
      // Big tool output after the report pushes it out of the first tail read.
      { day: '2026/10/06', lines: [event('2026-10-06T09:30:00Z', 40, 75), 'x'.repeat(400_000)] },
    ]);
    const found = codexLimits(home, home, Date.parse('2026-10-06T10:00:00Z'));
    expect(found?.windows.map((w) => w.usedPercent)).toEqual([40, 75]);
  });

  it('shows a window that reset since the report as 0%, and nothing when Codex never ran', () => {
    const home = codexHome([
      { day: '2026/10/06', lines: [event('2026-10-06T09:00:00Z', 60, 70, 1_791_280_000)] },
    ]);
    const after = (1_791_280_000 + 1) * 1000;
    const found = codexLimits(home, home, after);
    expect(found?.windows[0]).toMatchObject({
      usedPercent: 0,
      resetsAt: null,
      resetSinceReport: true,
    });
    expect(codexLimits(home, path.join(home, 'missing'), after)).toBeNull();
  });

  it('labels windows', () => {
    expect([windowLabel(300), windowLabel(10_080), windowLabel(60), windowLabel(2880)]).toEqual([
      '5-hour',
      'Weekly',
      '1-hour',
      '2-day',
    ]);
  });
});

describe('Claude Code usage limits', () => {
  it('reads what the status line recorder saved, as documented (percentage, unix seconds)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-claude-'));
    dirs.push(dir);
    expect(claudeLimits(dir)).toBeNull(); // Nothing recorded yet.
    writeFileSync(
      path.join(dir, 'claude-limits.json'),
      JSON.stringify({
        asOf: '2026-10-06T13:00:00Z',
        fiveHour: { used_percentage: 94, resets_at: 1_791_308_133 },
        sevenDay: { used_percentage: 13, resets_at: '2026-10-12T19:00:00Z' },
      }),
    );
    const found = claudeLimits(dir, Date.parse('2026-10-06T13:00:00Z'));
    expect(found?.providerId).toBe('claude');
    expect(found?.windows.map((w) => [w.label, w.usedPercent, w.resetsAt])).toEqual([
      ['5-hour', 94, new Date(1_791_308_133_000).toISOString()],
      ['Weekly', 13, '2026-10-12T19:00:00.000Z'],
    ]);
    expect(claudeLimits(null)).toBeNull();
  });
});

it.each([undefined, '', 'invalid'])(
  'does not invent freshness for an undated Codex report (%s)',
  (timestamp) => {
    const report = JSON.parse(event('2026-10-06T13:00:00Z', 20, 30));
    report.timestamp = timestamp;
    expect(lastCodexLimits(JSON.stringify(report))).toBeNull();
  },
);
it.each([undefined, '', 'invalid'])(
  'does not invent freshness for an undated Claude report (%s)',
  (asOf) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-undated-usage-'));
    dirs.push(dir);
    writeFileSync(
      path.join(dir, 'claude-limits.json'),
      JSON.stringify({ asOf, fiveHour: { used_percentage: 20 } }),
    );
    expect(claudeLimits(dir, Date.parse('2026-10-06T13:00:00Z'))).toBeNull();
  },
);

it('isolates cached quota by source directory and refreshes after clock rollback', () => {
  const first = mkdtempSync(path.join(os.tmpdir(), 'pm-quota-cache-a-'));
  const second = mkdtempSync(path.join(os.tmpdir(), 'pm-quota-cache-b-'));
  dirs.push(first, second);
  vi.stubEnv('CODEX_HOME', first);
  const now = Date.parse('2026-10-06T13:00:00Z');
  const save = (dir: string, used: number) =>
    writeFileSync(
      path.join(dir, 'claude-limits.json'),
      JSON.stringify({ asOf: new Date(now).toISOString(), fiveHour: { used_percentage: used } }),
    );
  try {
    save(first, 10);
    save(second, 80);
    const usage = (dir: string, at: number) =>
      readLimits(dir, at).find((value) => value.providerId === 'claude')?.windows[0]?.usedPercent;
    expect(usage(first, now)).toBe(10);
    expect(usage(second, now + 1)).toBe(80);
    save(second, 30);
    expect(usage(second, now + 2)).toBe(80);
    expect(usage(second, now - 1)).toBe(30);
  } finally {
    vi.unstubAllEnvs();
  }
});
