import type { ProjectBranch } from '../../../shared/branches';

// Filtering for the Overview's "Other branches" list. Pure, so the rules are tested without a DOM.
// One facet (what kind of branch) combines with a free-text search: every search word must match
// the name, upstream, commit hash or commit message. Facet counts follow the search, so a count is
// always what pressing that chip would show.

export type BranchFacet = 'all' | 'local' | 'remote' | 'worktree' | 'diverged' | 'gone' | 'stale';
export type BranchSort = 'recent' | 'name';

export const STALE_DAYS = 90;
const DAY_MS = 86_400_000;

export const FACET_LABELS: Record<BranchFacet, string> = {
  all: 'All',
  local: 'Local',
  remote: 'Remote',
  worktree: 'In worktree',
  diverged: 'Ahead or behind',
  gone: 'Upstream gone',
  stale: `Older than ${STALE_DAYS} days`,
};
const FACETS = Object.keys(FACET_LABELS) as BranchFacet[];

/** git's %(upstream:track): "[ahead 2]", "[behind 1]", "[ahead 2, behind 1]", "[gone]" or "". */
export function parseTracking(tracking: string) {
  return {
    ahead: Number(/ahead (\d+)/.exec(tracking)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(tracking)?.[1] ?? 0),
    gone: /\bgone\b/.test(tracking),
  };
}

/** Case and accent insensitive, so "sua loi" finds "Sửa lỗi". */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/đ/gi, 'd')
    .toLocaleLowerCase();

export function searchTerms(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

function matchesTerms(branch: ProjectBranch, terms: string[]) {
  if (!terms.length) return true;
  const haystack = fold(
    [branch.name, branch.upstream ?? '', branch.hash, branch.subject].join('\n'),
  );
  return terms.every((t) => haystack.includes(t));
}

export function inFacet(branch: ProjectBranch, facet: BranchFacet, now: number): boolean {
  switch (facet) {
    case 'all':
      return true;
    case 'local':
      return !branch.remote;
    case 'remote':
      return branch.remote;
    case 'worktree':
      return branch.worktree;
    case 'diverged': {
      const t = parseTracking(branch.tracking);
      return !branch.remote && (t.ahead > 0 || t.behind > 0);
    }
    case 'gone':
      return !branch.remote && parseTracking(branch.tracking).gone;
    case 'stale': {
      const at = Date.parse(branch.committedAt);
      return Number.isFinite(at) && now - at > STALE_DAYS * DAY_MS;
    }
  }
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
function sortBranches(list: ProjectBranch[], sort: BranchSort) {
  if (sort === 'name') return [...list].sort((a, b) => byName.compare(a.name, b.name));
  // Newest commit first; refs without a date go last, in their original order.
  const time = (b: ProjectBranch) => Date.parse(b.committedAt) || 0;
  return [...list].sort((a, b) => time(b) - time(a));
}

export interface BranchFilter {
  query: string;
  facet: BranchFacet;
  sort: BranchSort;
}

export function filterBranches(
  branches: ProjectBranch[],
  { query, facet, sort }: BranchFilter,
  now: number,
) {
  const terms = searchTerms(query);
  const searched = branches.filter((b) => matchesTerms(b, terms));
  const counts = Object.fromEntries(
    FACETS.map((f) => [f, searched.filter((b) => inFacet(b, f, now)).length]),
  ) as Record<BranchFacet, number>;
  return {
    shown: sortBranches(
      searched.filter((b) => inFacet(b, facet, now)),
      sort,
    ),
    counts,
  };
}

/**
 * Chips worth offering: All, the chosen one, and any facet the full list has at least one branch
 * in (so a chip never appears and vanishes as the user types, and empty kinds never show).
 */
export function offeredFacets(branches: ProjectBranch[], selected: BranchFacet, now: number) {
  return FACETS.filter(
    (f) => f === 'all' || f === selected || branches.some((b) => inFacet(b, f, now)),
  );
}
