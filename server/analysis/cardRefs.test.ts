import { describe, expect, it } from 'vitest';
import type { CardStatus } from '../../shared/types.js';
import { commitEvents, computeMoves, parseRefs, type RefEvent } from './cardRefs.js';

describe('parseRefs', () => {
  it('separates closing references from plain mentions', () => {
    expect(parseRefs('Fixes PM-3, refs PM-4 and closes: PM-5')).toEqual({
      closes: [3, 5],
      mentions: [4],
    });
    expect(parseRefs('pm-7 work in progress')).toEqual({ closes: [], mentions: [7] });
    expect(parseRefs('XPM-1 and PM-12a are not refs')).toEqual({ closes: [], mentions: [] });
  });
});

describe('computeMoves', () => {
  // Commits on the default branch, as the watcher reads them.
  const movesFor = (
    cards: Parameters<typeof computeMoves>[0],
    commits: Parameters<typeof commitEvents>[0],
  ) => computeMoves(cards, commitEvents(commits));
  const created = '2026-01-01T00:00:00Z';
  const card = (id: number, status: CardStatus = 'todo') => ({
    id,
    key: `PM-${id}`,
    status,
    createdAt: created,
  });
  const commit = (hash: string, message: string, committedAt = '2026-02-01T10:00:00+07:00') => ({
    hash,
    message,
    committedAt,
  });

  it('moves mentioned cards to in progress and closed cards to done', () => {
    const moves = movesFor(
      [card(1), card(2), card(3, 'review')],
      [commit('a', 'Start PM-1'), commit('b', 'Resolve PM-2'), commit('c', 'More on PM-3')],
    );
    expect(moves).toEqual([
      { cardId: 1, key: 'PM-1', from: 'todo', to: 'in_progress', commit: 'a' },
      { cardId: 2, key: 'PM-2', from: 'todo', to: 'done', commit: 'b' },
    ]);
  });

  it('ignores commits older than the card and unknown cards', () => {
    const moves = movesFor(
      [card(1)],
      [commit('a', 'Fixes PM-1', '2025-12-31T23:00:00Z'), commit('b', 'Fixes PM-99')],
    );
    expect(moves).toEqual([]);
  });

  it('counts a commit made in the same second as the card (git keeps whole seconds)', () => {
    // Card created at 01:58:05.072, "Fixes" committed at 01:58:05 (seen live: PM-20..25).
    const fresh = { ...card(1, 'in_progress'), createdAt: '2026-10-06T01:58:05.072Z' };
    const moves = movesFor([fresh], [commit('a', 'Fixes PM-1', '2026-10-06T08:58:05+07:00')]);
    expect(moves).toEqual([
      { cardId: 1, key: 'PM-1', from: 'in_progress', to: 'done', commit: 'a' },
    ]);
    // A commit a full second earlier is still older history.
    expect(movesFor([fresh], [commit('b', 'Fixes PM-1', '2026-10-06T08:58:04+07:00')])).toEqual([]);
  });

  it('lets a later close win over an earlier mention', () => {
    const moves = movesFor(
      [card(1, 'backlog')],
      [commit('a', 'PM-1 wip'), commit('b', 'fixed PM-1')],
    );
    expect(moves).toEqual([{ cardId: 1, key: 'PM-1', from: 'backlog', to: 'done', commit: 'b' }]);
  });

  it('follows the whole flow: branch work, pull request, merge (forward only)', () => {
    const at = (m: number) =>
      new Date(Date.parse('2026-03-01T00:00:00Z') + m * 60_000).toISOString();
    const event = (
      kind: RefEvent['kind'],
      text: string,
      m: number,
      id = `${kind}:${m}`,
    ): RefEvent => ({
      id,
      kind,
      at: at(m),
      text,
      source: id,
    });
    const cards = [card(1), card(2), card(3), card(4, 'review')];
    expect(
      computeMoves(cards, [
        event('branch', 'pm-1-login-form', 1), // A branch named after the card.
        event('branch-commit', 'Fixes PM-2 on a feature branch', 2), // Done there, not merged.
        event('pr-open', 'Add search\n\nCloses PM-3', 3),
        event('commit', 'Mention PM-4 again', 4), // Review never goes back to In progress.
      ]).map((m) => [m.key, m.to]),
    ).toEqual([
      ['PM-1', 'in_progress'],
      ['PM-2', 'review'],
      ['PM-3', 'review'],
    ]);
    expect(
      computeMoves([card(3, 'review')], [event('pr-merged', 'Add search (pm-3-search)', 5)]),
    ).toEqual([{ cardId: 3, key: 'PM-3', from: 'review', to: 'done', commit: 'pr-merged:5' }]);
  });

  it('a branch commit and the same commit once merged are separate events', () => {
    const [c] = [commit('abc', 'Fixes PM-1')];
    expect(commitEvents([c!], 'branch-commit')[0]!.id).toBe('abc:branch');
    expect(commitEvents([c!], 'commit')[0]!.id).toBe('abc');
  });
});
