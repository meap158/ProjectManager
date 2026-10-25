import type { FolderItem } from '../../../shared/types';

// The folder previewer's pure rules (PM-286): what kind of thing an entry is, which entries a set of
// filters keeps, how they sort, what changed since you last looked, and how all of it round-trips
// through the address so a view can be linked and survives a reload.

export type TypeGroup =
  'folder' | 'image' | 'video' | 'audio' | 'document' | 'code' | 'data' | 'archive' | 'other';

/** The groups offered as filters, in the order shown (folders are always kept unless filtered by name). */
export const FILE_GROUPS: { id: Exclude<TypeGroup, 'folder'>; label: string }[] = [
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'document', label: 'Docs' },
  { id: 'code', label: 'Code' },
  { id: 'data', label: 'Data' },
  { id: 'archive', label: 'Archives' },
  { id: 'other', label: 'Other' },
];

const GROUPS: Record<string, Exclude<TypeGroup, 'folder' | 'other'>> = {};
const add = (group: Exclude<TypeGroup, 'folder' | 'other'>, extensions: string) => {
  for (const ext of extensions.split(' ')) GROUPS[ext] = group;
};
add('image', 'png jpg jpeg gif webp avif svg ico bmp tif tiff heic psd');
add('video', 'mp4 mov webm mkv avi m4v');
add('audio', 'mp3 wav ogg flac m4a aac opus');
add('document', 'md mdx txt pdf doc docx rtf odt html htm csv xlsx xls pptx');
add(
  'code',
  'ts tsx js jsx mjs cjs py rs go java kt cs c h cpp rb php swift sh bat cmd ps1 css scss less sql vue',
);
add('data', 'json jsonl yaml yml toml xml ini cfg conf env lock log db sqlite');
add('archive', 'zip gz tar tgz 7z rar');

export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

export function typeGroupOf(item: Pick<FolderItem, 'name' | 'kind'>): TypeGroup {
  if (item.kind === 'dir') return 'folder';
  return GROUPS[extensionOf(item.name)] ?? 'other';
}

export type SortKey = 'modified' | 'name' | 'size' | 'type';
export type ModifiedRange = 'any' | 'today' | '7d' | '30d';
export type ViewMode = 'grid' | 'list';

export interface FolderViewState {
  view: ViewMode;
  sort: SortKey;
  /** Newest first, largest first, A to Z (name) and A to Z (type) by default. */
  descending: boolean;
  text: string;
  types: Exclude<TypeGroup, 'folder'>[];
  modified: ModifiedRange;
  recursive: boolean;
}

export const DEFAULT_VIEW: FolderViewState = {
  view: 'grid',
  sort: 'modified',
  descending: true,
  text: '',
  types: [],
  modified: 'any',
  recursive: false,
};

const SORTS: SortKey[] = ['modified', 'name', 'size', 'type'];
const RANGES: ModifiedRange[] = ['any', 'today', '7d', '30d'];

/** The view in the address: only what differs from the default, so links stay short. */
export function writeViewParams(state: FolderViewState, params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of ['view', 'sort', 'order', 'q', 'types', 'mod', 'rec']) next.delete(key);
  if (state.view !== DEFAULT_VIEW.view) next.set('view', state.view);
  if (state.sort !== DEFAULT_VIEW.sort) next.set('sort', state.sort);
  if (state.descending !== defaultDescending(state.sort))
    next.set('order', state.descending ? 'desc' : 'asc');
  if (state.text.trim()) next.set('q', state.text.trim());
  if (state.types.length) next.set('types', state.types.join(','));
  if (state.modified !== 'any') next.set('mod', state.modified);
  if (state.recursive) next.set('rec', '1');
  return next;
}

/** Name and type read A to Z; modified and size read biggest or newest first. */
export const defaultDescending = (sort: SortKey): boolean => sort === 'modified' || sort === 'size';

/** The view from the address; unknown values fall back to the default rather than failing. */
export function readViewParams(params: URLSearchParams): FolderViewState {
  const sort = SORTS.includes(params.get('sort') as SortKey)
    ? (params.get('sort') as SortKey)
    : DEFAULT_VIEW.sort;
  const order = params.get('order');
  const known = new Set(FILE_GROUPS.map((g) => g.id as string));
  return {
    view: params.get('view') === 'list' ? 'list' : 'grid',
    sort,
    descending: order === 'desc' ? true : order === 'asc' ? false : defaultDescending(sort),
    text: params.get('q') ?? '',
    types: (params.get('types') ?? '')
      .split(',')
      .filter((t) => known.has(t)) as FolderViewState['types'],
    modified: RANGES.includes(params.get('mod') as ModifiedRange)
      ? (params.get('mod') as ModifiedRange)
      : 'any',
    recursive: params.get('rec') === '1',
  };
}

const DAY = 86_400_000;

/** Entries that pass the filters. Folders pass a type filter (you still need to navigate). */
export function applyFilters(
  items: readonly FolderItem[],
  state: FolderViewState,
  now = Date.now(),
): FolderItem[] {
  const needle = state.text.trim().toLowerCase();
  const since =
    state.modified === 'today'
      ? startOfDay(now)
      : state.modified === '7d'
        ? now - 7 * DAY
        : state.modified === '30d'
          ? now - 30 * DAY
          : null;
  return items.filter((item) => {
    if (needle && !item.path.toLowerCase().includes(needle)) return false;
    // Folders are for navigating: they stay while only the name filter is used, and give way to a
    // type or date filter, which asks for files.
    if (item.kind === 'dir') return since === null && state.types.length === 0;
    if (state.types.length && !state.types.includes(typeGroupOf(item) as never)) return false;
    if (since !== null && (!item.mtime || Date.parse(item.mtime) < since)) return false;
    return true;
  });
}

function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders stay together at the front (like the tree); the rest by the chosen key. */
export function sortItems(
  items: readonly FolderItem[],
  sort: SortKey,
  descending: boolean,
): FolderItem[] {
  const sign = descending ? -1 : 1;
  const time = (item: FolderItem) => (item.mtime ? Date.parse(item.mtime) : 0);
  const compare = (a: FolderItem, b: FolderItem): number => {
    switch (sort) {
      case 'modified':
        return time(a) - time(b) || collator.compare(a.name, b.name);
      case 'size':
        return (a.size ?? 0) - (b.size ?? 0) || collator.compare(a.name, b.name);
      case 'type':
        return (
          collator.compare(extensionOf(a.name), extensionOf(b.name)) ||
          collator.compare(a.name, b.name)
        );
      default:
        return collator.compare(a.name, b.name);
    }
  };
  return [...items].sort((a, b) =>
    a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : sign * compare(a, b),
  );
}

/**
 * Whether an entry is new or changed since a moment: modified after it, or created after it.
 * With no earlier visit (null) nothing is marked: there is nothing to compare against yet.
 */
export function changedSince(item: FolderItem, seenAt: number | null): 'new' | 'changed' | null {
  if (seenAt === null || item.kind === 'dir') return null;
  const created = item.ctime ? Date.parse(item.ctime) : 0;
  const modified = item.mtime ? Date.parse(item.mtime) : 0;
  if (created > seenAt) return 'new';
  return modified > seenAt ? 'changed' : null;
}

export const seenKey = (projectId: number, dir: string) => `pm.folderSeen.${projectId}:${dir}`;

export function readSeen(projectId: number, dir: string): number | null {
  try {
    const raw = localStorage.getItem(seenKey(projectId, dir));
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeSeen(projectId: number, dir: string, at: number): void {
  try {
    localStorage.setItem(seenKey(projectId, dir), String(at));
  } catch {
    // Not remembered: the next visit simply marks nothing.
  }
}

const VIEW_KEYS = ['view', 'sort', 'order', 'q', 'types', 'mod', 'rec'];

/** Whether the address already says how to show the folder (then it, not the saved view, rules). */
export const hasViewParams = (params: URLSearchParams): boolean =>
  VIEW_KEYS.some((key) => params.has(key));

const viewKey = (projectId: number, dir: string) => `pm.folderView.${projectId}:${dir}`;

/**
 * The filters, sort and layout last used in a folder, kept per project and folder so that choosing
 * Images in one folder is still in force when you come back to it (from a file, a pin, the tree or
 * another folder). Null when none were saved.
 */
export function readSavedView(projectId: number, dir: string): URLSearchParams | null {
  try {
    const raw = localStorage.getItem(viewKey(projectId, dir));
    return raw ? new URLSearchParams(raw) : null;
  } catch {
    return null;
  }
}

export function writeSavedView(projectId: number, dir: string, state: FolderViewState): void {
  try {
    const text = writeViewParams(state, new URLSearchParams()).toString();
    // The default view is not stored: nothing to restore.
    if (text) localStorage.setItem(viewKey(projectId, dir), text);
    else localStorage.removeItem(viewKey(projectId, dir));
  } catch {
    // Not remembered; the address still carries the view.
  }
}
