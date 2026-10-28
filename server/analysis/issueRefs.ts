import type { Card } from '../../shared/types.js';
import type { RefEvent } from './cardRefs.js';

const ISSUE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)$/i;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function parseGitHubIssueUrl(
  url: string,
): { owner: string; repo: string; number: number } | null {
  const match = url.match(ISSUE);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}
export function githubRepository(remote: string | null): string | null {
  const match = remote?.match(
    /(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/i,
  );
  return match?.[1]?.toLowerCase() ?? null;
}
/** Translate only explicitly linked issues, never confuse issue #12 with PM-12. */
export function issueReferenceEvents(
  cards: Card[],
  events: RefEvent[],
  remote: string | null,
): RefEvent[] {
  const repository = githubRepository(remote);
  return events.flatMap((event) =>
    cards.flatMap((card): RefEvent[] => {
      const match = card.issueUrl?.match(ISSUE);
      if (!match) return [];
      const repo = `${match[1]}/${match[2]}`;
      const number = match[3]!;
      const refs = [escape(card.issueUrl!), `${escape(repo)}#${number}`];
      if (repository === repo.toLowerCase()) refs.push(`(?<![\\w/])#${number}`);
      const ref = `(?:${refs.join('|')})(?![\\w/])`;
      if (!new RegExp(ref, 'i').test(event.text)) return [];
      const closing = new RegExp(
        `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b[\\s:]*${ref}`,
        'i',
      ).test(event.text);
      // A mention on a merged PR is evidence of work, not proof that this issue was resolved.
      const confirmed =
        closing &&
        (event.kind !== 'pr-merged' ||
          event.issueClosures?.some((url) => url.toLowerCase() === card.issueUrl?.toLowerCase()));
      const kind = event.kind === 'pr-merged' && !confirmed ? 'pr-open' : event.kind;
      return [
        {
          ...event,
          id: `${event.id}:issue:${card.id}`,
          kind,
          text: `${closing ? 'Closes ' : ''}${card.key}`,
        },
      ];
    }),
  );
}
