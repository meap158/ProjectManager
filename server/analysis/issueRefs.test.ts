import { expect, it } from 'vitest';
import type { Card } from '../../shared/types.js';
import { computeMoves, type RefEvent } from './cardRefs.js';
import { githubRepository, issueReferenceEvents } from './issueRefs.js';
const card = {
  id: 91,
  key: 'PM-91',
  status: 'todo',
  createdAt: '2026-10-01',
  issueUrl: 'https://github.com/me/app/issues/12',
} as Card;
const event = (kind: RefEvent['kind'], text: string): RefEvent => ({
  id: 'abc',
  kind,
  text,
  at: '2026-10-02',
  source: 'abc',
});
function moves(kind: RefEvent['kind'], text: string, remote = 'git@github.com:me/app.git') {
  return computeMoves([card], issueReferenceEvents([card], [event(kind, text)], remote));
}
it('isolates short issue references to the project repository', () => {
  expect(githubRepository('git@github.com:me/app.git')).toBe('me/app');
  expect(moves('commit', 'Work on #12')[0]?.to).toBe('in_progress');
  expect(moves('commit', 'Fixes #12')[0]?.to).toBe('done');
  expect(moves('commit', 'Fixes #12', 'https://github.com/other/app.git')).toEqual([]);
  expect(moves('commit', 'Fixes other/app#12')).toEqual([]);
  expect(moves('commit', 'Fixes #123')).toEqual([]);
});
it('moves linked PR work to review and only completes closing references', () => {
  expect(moves('pr-open', 'Related to #12')[0]?.to).toBe('review');
  expect(moves('pr-merged', 'Related to #12')[0]?.to).toBe('review');
  expect(moves('pr-merged', 'Closes https://github.com/me/app/issues/12')[0]?.to).toBe('review');
  const merged = { ...event('pr-merged', 'Closes #12'), issueClosures: [card.issueUrl!] };
  expect(
    computeMoves([card], issueReferenceEvents([card], [merged], 'https://github.com/me/app'))[0]
      ?.to,
  ).toBe('done');
  expect(moves('branch-commit', 'Fixes me/app#12')[0]?.to).toBe('review');
});
