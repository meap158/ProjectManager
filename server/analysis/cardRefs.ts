import { CARD_KEY_PREFIX, type CardMove, type CardStatus } from '../../shared/types.js';
import type { CommitMessage } from './git.js';

// Cards follow the work on their own, from what git and GitHub already record; no agent needed.
// The flow is the usual Linear/GitHub one (documented in README.md):
//
//   event                                   "Fixes PM-12" (close words)   any other "PM-12"
//   commit on the default branch            Done                           In progress
//   commit on another branch (not merged)   Review (awaiting merge)        In progress
//   branch named after the card (pm-12-…)   —                              In progress
//   pull request open                       Review                         Review
//   pull request merged                     Done                           Done
//
// Cards only ever move forward (Backlog → To do → In progress → Review → Done), events older
// than a card are ignored, and each event is applied once, so a card moved back by hand stays.

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

export type RefKind = 'commit' | 'branch-commit' | 'branch' | 'pr-open' | 'pr-merged';

/** Something that happened in git or on GitHub that may reference cards. */
export interface RefEvent {
  /** Stable per event *and* state (a commit counts again once merged), for apply-once. */
  id: string;
  kind: RefKind;
  /** When it happened (ISO). */
  at: string;
  /** Text searched for card keys: commit message, branch name, PR title + body + branch. */
  text: string;
  /** Recorded on the moved card: a commit hash, or "PR #12". */
  source: string;
}

const RANK: Record<CardStatus, number> = {
  backlog: 0,
  todo: 1,
  in_progress: 2,
  review: 3,
  done: 4,
};

/** Where an event sends the cards it closes, and the ones it only mentions. */
const TARGETS: Record<RefKind, { closes: CardStatus; mentions: CardStatus | null }> = {
  commit: { closes: 'done', mentions: 'in_progress' },
  'branch-commit': { closes: 'review', mentions: 'in_progress' },
  branch: { closes: 'in_progress', mentions: 'in_progress' },
  'pr-open': { closes: 'review', mentions: 'review' },
  'pr-merged': { closes: 'done', mentions: 'done' },
};

export function parseRefs(message: string): { closes: number[]; mentions: number[] } {
  const closes = [...message.matchAll(CLOSING_RE)].map((m) => Number(m[1]));
  const mentions = [...message.matchAll(MENTION_RE)].map((m) => Number(m[1]));
  return {
    closes: unique(closes),
    mentions: unique(mentions.filter((id) => !closes.includes(id))),
  };
}

/** Commits as events: on the default branch ('commit') or only on other branches. */
export function commitEvents(
  commits: CommitMessage[],
  kind: 'commit' | 'branch-commit' = 'commit',
): RefEvent[] {
  return commits.map((c) => ({
    // A branch commit is a different event from the same commit once merged.
    id: kind === 'commit' ? c.hash : `${c.hash}:branch`,
    kind,
    at: c.committedAt,
    text: c.message,
    source: c.hash,
  }));
}

/**
 * Replays events (oldest first) against cards and returns the status changes they imply. Events
 * older than a card are ignored, so stale history can't move a freshly created card.
 */
export function computeMoves(cards: CardRefTarget[], events: RefEvent[]): CardMove[] {
  const state = new Map(cards.map((c) => [c.id, { ...c, original: c.status }]));
  const lastSource = new Map<number, string>();
  const ordered = events.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  for (const event of ordered) {
    const { closes, mentions } = parseRefs(event.text);
    const at = Date.parse(event.at);
    const target = TARGETS[event.kind];
    // Git keeps whole seconds and cards keep milliseconds: an event in the same second as the
    // card (e.g. card created, then committed right away) must still count.
    const applies = (card: CardRefTarget) =>
      at >= Math.floor(Date.parse(card.createdAt) / 1000) * 1000;
    const move = (id: number, to: CardStatus | null) => {
      const card = state.get(id);
      if (!to || !card || !applies(card) || RANK[to] <= RANK[card.status]) return;
      card.status = to;
      lastSource.set(id, event.source);
    };
    for (const id of closes) move(id, target.closes);
    for (const id of mentions) move(id, target.mentions);
  }

  return [...state.values()]
    .filter((c) => c.status !== c.original)
    .map((c) => ({
      cardId: c.id,
      key: c.key,
      from: c.original,
      to: c.status,
      commit: lastSource.get(c.id)!,
    }));
}

function unique(ids: number[]): number[] {
  return [...new Set(ids)];
}
