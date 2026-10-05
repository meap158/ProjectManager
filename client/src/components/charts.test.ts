import { describe, expect, it } from 'vitest';
import { columnTicks, valueLabelIndexes } from './charts';

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
