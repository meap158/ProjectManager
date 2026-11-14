import { expect, it } from 'vitest';
import { DRAFT_HOLD_MS, ownerDrafting, draftKeyEffect, emptyClaudeInput } from './drafting.js';

it('distinguishes editing from navigation and explicit line clearing', () => {
  for (const key of ['\x1b[D', '\x1b[C', '\x1b[Z', '\x1b'])
    expect(draftKeyEffect(key)).toBe('keep');
  for (const key of ['hello', '\x7f', '\x1b[A', '\t']) expect(draftKeyEffect(key)).toBe('hold');
  for (const key of ['\r', '/model\r', '\x15', '\x03']) expect(draftKeyEffect(key)).toBe('clear');
});
it('requires a complete empty current Claude input box, never a historical prompt or multiline draft', () => {
  const rule = '────────────────────────────────';
  expect(emptyClaudeInput(`${rule}\n> \n${rule}\nauto mode on`)).toBe(true);
  expect(emptyClaudeInput(`${rule}\n❯ \n\n${rule}`)).toBe(true);
  for (const screen of [
    '> ',
    `${rule}\n> draft\n${rule}`,
    `${rule}\n> \nsecond line\n${rule}`,
    `${rule}\n> \n${rule}\n> draft`,
    `${rule}\n> \n${rule}\nA newer response without its input box`,
    `${rule}\n> \n`,
    'unreadable terminal',
  ])
    expect(emptyClaudeInput(screen)).toBe(false);
});

it("counts the input box as the owner's for a while after an unsent key (PM-726)", () => {
  const now = Date.parse('2026-11-13T10:00:00Z');
  const at = (ms: number) => ({ lastKeyAt: new Date(now - ms).toISOString() });
  expect(ownerDrafting(at(1_000), now)).toBe(true);
  expect(ownerDrafting(at(DRAFT_HOLD_MS - 1), now)).toBe(true);
  expect(ownerDrafting(at(DRAFT_HOLD_MS), now)).toBe(false);
  expect(ownerDrafting({ lastKeyAt: null }, now)).toBe(false);
  expect(ownerDrafting(null, now)).toBe(false);
});
