import { expect, it } from 'vitest';
import { DRAFT_HOLD_MS, ownerDrafting } from './drafting.js';

it("counts the input box as the owner's for a while after an unsent key (PM-726)", () => {
  const now = Date.parse('2026-11-13T10:00:00Z');
  const at = (ms: number) => ({ lastKeyAt: new Date(now - ms).toISOString() });
  expect(ownerDrafting(at(1_000), now)).toBe(true);
  expect(ownerDrafting(at(DRAFT_HOLD_MS - 1), now)).toBe(true);
  expect(ownerDrafting(at(DRAFT_HOLD_MS), now)).toBe(false);
  expect(ownerDrafting({ lastKeyAt: null }, now)).toBe(false);
  expect(ownerDrafting(null, now)).toBe(false);
});
