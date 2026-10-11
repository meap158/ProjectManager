import { expect, it } from 'vitest';
import { tailState } from './activity.js';

const approval =
  'Allow command?\n\u203a 1. Yes, proceed\n  2. No, tell Codex differently\nPress enter to confirm or esc to cancel';
it('clears dismissed approvals when the normal conversation prompt returns', () => {
  expect(tailState(approval + '\nRequest declined.\nAsk Codex to do anything')).toBe('idle');
  expect(tailState(approval + '\nDeclined\n\u276f ')).toBe('idle');
  expect(tailState(approval + '\nCanceled\n> ')).toBe('idle');
});
it('keeps a new approval after an earlier conversation prompt flagged', () => {
  expect(tailState('Ask Codex to do anything\n' + approval)).toBe('input');
});
it('does not treat a menu cancel hint as evidence the choice was dismissed', () => {
  expect(tailState(approval)).toBe('input');
});
it('preserves busy work after returning to a normal prompt', () => {
  expect(tailState(approval + '\nWorking (3s, esc to interrupt)\nAsk Codex to do anything')).toBe(
    'running',
  );
});
