import { CARD_KEY_PREFIX, type CardMove, type CardStatus } from '../../shared/types.js';
import type { CommitMessage } from './git.js';

// Commit-message conventions (documented in README.md):
//   "Fixes PM-12" / "closes PM-12" / "resolved: PM-12"  -> card moves to Done
//   any other mention of "PM-12"                         -> card moves to In progress
//                                                          (only from Backlog or To do)
const KEY = String.raw`${CARD_KEY_PREFIX}-(\d+)`;
const CLOSING_RE = new RegExp(
  String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|complete[sd]?)\b[\s:]*${KEY}\b`,
  'gi',
);
const MENTION_RE = new RegExp(String.raw`\b${KEY}\b`, 'gi');

export interface CardRefTarget {
  id: number;
  key: string;
  status: CardStatus;
  createdAt: string;
}

export function parseRefs(message: string): { closes: number[]; mentions: number[] } {
  const closes = [...message.matchAll(CLOSING_RE)].map((m) => Number(m[1]));
  const mentions = [...message.matchAll(MENTION_RE)].map((m) => Number(m[1]));
  return {
    closes: unique(closes),
    mentions: unique(mentions.filter((id) => !closes.includes(id))),
  };
}

/**
 * Replays commits (oldest first) against cards and returns the status changes they imply. Commits
 * older than a card are ignored, so stale history can't move a freshly created card.
 */
export function computeMoves(cards: CardRefTarget[], commits: CommitMessage[]): CardMove[] {
  const state = new Map(cards.map((c) => [c.id, { ...c, original: c.status }]));
  const lastCommit = new Map<number, string>();

  for (const commit of commits) {
    const { closes, mentions } = parseRefs(commit.message);
    const committed = Date.parse(commit.committedAt);
    // Git keeps whole seconds and cards keep milliseconds: a commit made in the same second as
    // the card (e.g. card created, then committed right away) must still count.
    const applies = (card: CardRefTarget) =>
      committed >= Math.floor(Date.parse(card.createdAt) / 1000) * 1000;

    for (const id of closes) {
      const card = state.get(id);
      if (card && applies(card) && card.status !== 'done') {
        card.status = 'done';
        lastCommit.set(id, commit.hash);
      }
    }
    for (const id of mentions) {
      const card = state.get(id);
      if (card && applies(card) && (card.status === 'backlog' || card.status === 'todo')) {
        card.status = 'in_progress';
        lastCommit.set(id, commit.hash);
      }
    }
  }

  return [...state.values()]
    .filter((c) => c.status !== c.original)
    .map((c) => ({
      cardId: c.id,
      key: c.key,
      from: c.original,
      to: c.status,
      commit: lastCommit.get(c.id)!,
    }));
}

function unique(ids: number[]): number[] {
  return [...new Set(ids)];
}
