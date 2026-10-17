import { describe, expect, it } from 'vitest';
import { clampTooltipPosition, columnTicks, valueLabelIndexes } from './charts';

describe('columnTicks', () => {
  it('uses round, whole-number steps with the peak under the top line', () => {
    expect(columnTicks(31)).toEqual([0, 10, 20, 30, 40]);
    expect(columnTicks(3)).toEqual([0, 1, 2, 3, 4]);
    expect(columnTicks(0)).toEqual([0, 1, 2, 3, 4]);
    expect(columnTicks(180)).toEqual([0, 50, 100, 150, 200]);
    expect(columnTicks(95)).toEqual([0, 25, 50, 75, 100]);
    for (const max of [1, 7, 13, 99, 1234]) {
      const ticks = columnTicks(max);
      expect(ticks.at(-1)).toBeGreaterThanOrEqual(max);
      expect(ticks.every(Number.isInteger)).toBe(true);
    }
  });
});

describe('valueLabelIndexes', () => {
  it('labels every non-zero column when there is room', () => {
    expect([...valueLabelIndexes([0, 3, 0, 5], 16)]).toEqual([1, 3]);
  });
  it('labels only the peak and the latest non-zero column when dense', () => {
    const totals = [1, 9, 2, 0, 4, 0];
    expect([...valueLabelIndexes(totals, 3)].sort()).toEqual([1, 4]);
  });
});

describe('clampTooltipPosition', () => {
  it('clamps tooltips near left, right, and top viewport edges', () => {
    // 180px wide tooltip (half = 90px), 60px tall, on a 360x640 mobile viewport:
    // Left edge: x=30 would place left edge at -60px; clamped to 8 + 90 = 98px.
    expect(clampTooltipPosition(30, 200, 180, 60, 360, 640)).toEqual({ left: 98, top: 200 });
    // Right edge: x=345 would place right edge at 435px; clamped to 360 - 8 - 90 = 262px.
    expect(clampTooltipPosition(345, 200, 180, 60, 360, 640)).toEqual({ left: 262, top: 200 });
    // Center: stays centered on the column at x=180.
    expect(clampTooltipPosition(180, 200, 180, 60, 360, 640)).toEqual({ left: 180, top: 200 });
    // Top edge: y=40 would place top edge above viewport; clamped to 8 + 60 + 10 = 78px.
    expect(clampTooltipPosition(180, 40, 180, 60, 360, 640)).toEqual({ left: 180, top: 78 });
  });
});
