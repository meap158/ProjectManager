import { describe, expect, it } from 'vitest';
import { applyCustomOrder, mergeVisibleOrder, moveBefore, moveBy } from './projectOrder';

const p = (id: number, name: string) => ({ id, name });

describe('custom project order', () => {
  it('follows the saved order, with unknown projects after it A–Z', () => {
    const projects = [p(1, 'Alpha'), p(2, 'Beta'), p(3, 'Gamma'), p(4, 'Delta')];
    expect(applyCustomOrder(projects, [3, 1]).map((x) => x.id)).toEqual([3, 1, 2, 4]);
  });

  it('reordering a filtered subset keeps hidden projects in their places', () => {
    // 2 and 4 are hidden by a filter; the visible 1, 3, 5 become 5, 1, 3.
    expect(mergeVisibleOrder([1, 2, 3, 4, 5], [5, 1, 3])).toEqual([5, 2, 1, 4, 3]);
  });

  it('moves before a target, to the end, or a step at a time', () => {
    expect(moveBefore([1, 2, 3, 4], 4, 2)).toEqual([1, 4, 2, 3]);
    expect(moveBefore([1, 2, 3, 4], 1, null)).toEqual([2, 3, 4, 1]);
    expect(moveBy([1, 2, 3], 2, -1)).toEqual([2, 1, 3]);
    expect(moveBy([1, 2, 3], 1, -1)).toEqual([1, 2, 3]);
  });
});
