import { describe, expect, it } from 'vitest';
import type { CardStatus } from '../../shared/types.js';
import { computeMoves, parseRefs } from './cardRefs.js';

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
    const moves = computeMoves(
      [card(1), card(2), card(3, 'review')],
      [commit('a', 'Start PM-1'), commit('b', 'Resolve PM-2'), commit('c', 'More on PM-3')],
    );
    expect(moves).toEqual([
      { cardId: 1, key: 'PM-1', from: 'todo', to: 'in_progress', commit: 'a' },
      { cardId: 2, key: 'PM-2', from: 'todo', to: 'done', commit: 'b' },
    ]);
  });

  it('ignores commits older than the card and unknown cards', () => {
    const moves = computeMoves(
      [card(1)],
      [commit('a', 'Fixes PM-1', '2025-12-31T23:00:00Z'), commit('b', 'Fixes PM-99')],
    );
    expect(moves).toEqual([]);
  });

  it('lets a later close win over an earlier mention', () => {
    const moves = computeMoves(
      [card(1, 'backlog')],
      [commit('a', 'PM-1 wip'), commit('b', 'fixed PM-1')],
    );
    expect(moves).toEqual([{ cardId: 1, key: 'PM-1', from: 'backlog', to: 'done', commit: 'b' }]);
  });
});
