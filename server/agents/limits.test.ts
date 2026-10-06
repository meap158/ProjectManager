import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexLimits, lastCodexLimits, windowLabel } from './limits.js';

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
    expect(found?.asOf).toBe('2026-10-06T10:05:00Z');
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
