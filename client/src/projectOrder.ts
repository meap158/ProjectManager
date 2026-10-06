// Custom project order for the sidebar ("Custom order" sort, after KDP Publishing Pipeline's
// Library). The saved order is the full list of project ids; projects it doesn't know yet (newly
// added) follow it, A–Z.

interface Named {
  id: number;
  name: string;
}

/** Projects in the saved order; unknown ones after it, by name. */
export function applyCustomOrder<T extends Named>(projects: T[], order: number[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return projects.slice().sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/**
 * Folds a reordered *visible* subset back into the full order: the slots the visible projects held
 * are refilled in their new order, so projects hidden by a filter or search keep their places.
 */
export function mergeVisibleOrder(full: number[], visible: number[]): number[] {
  const shown = new Set(visible);
  const queue = [...visible];
  return full.map((id) => (shown.has(id) ? queue.shift()! : id));
}

/** `ids` with `id` moved to just before `before` (or to the end when `before` is null). */
export function moveBefore(ids: number[], id: number, before: number | null): number[] {
  if (id === before) return ids;
  const rest = ids.filter((x) => x !== id);
  const at = before === null ? rest.length : rest.indexOf(before);
  return at < 0 ? ids : [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** `ids` with `id` moved one step up (-1) or down (+1); unchanged at either end. */
export function moveBy(ids: number[], id: number, step: -1 | 1): number[] {
  const i = ids.indexOf(id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const next = ids.slice();
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}
