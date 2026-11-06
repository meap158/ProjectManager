/** Categorical colour slots for project tags (`--series-1` to `--series-7`). */
export const PROJECT_TAG_SLOTS = 7;

/**
 * A project keeps its tag colour everywhere (PM-449): slots in fixed order by project id, over
 * every project and every project a card belongs to (0 is "All projects"). The Board and the
 * orchestrator goals use the same ids, so a project reads the same colour in both.
 */
export function projectTagColors(ids: Iterable<number>): Map<number, string> {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  return new Map(sorted.map((id, i) => [id, `var(--series-${(i % PROJECT_TAG_SLOTS) + 1})`]));
}
