import { describe, expect, it } from 'vitest';
import { budgetChoices } from './CpuBudgetPanel';

describe('CPU budget choices', () => {
  it('offers one thread, whole cores and everything', () => {
    expect(budgetChoices(20)).toEqual([1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(budgetChoices(5)).toEqual([1, 2, 4, 5]);
    expect(budgetChoices(1)).toEqual([1]);
  });
});
