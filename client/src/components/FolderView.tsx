import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useSearchParams } from 'react-router';
import { mediaKind } from '../../../shared/media';
import type { FolderInfo, FolderItem } from '../../../shared/types';
import { api } from '../api';
import { formatBytes, formatRelative } from '../format';
import { Dropdown, type DropdownOption } from './Dropdown';
import {
  FILE_GROUPS,
  hasViewParams,
  readSavedView,
  writeSavedView,
  applyFilters,
  changedSince,
  canPreviewImage,
  readSeen,
  readViewParams,
  sortItems,
  typeGroupOf,
  writeSeen,
  writeViewParams,
  defaultDescending,
  type FolderViewState,
  type ModifiedRange,
  type SortKey,
} from './folderRules';
import { FileTypeIcon, iconFor } from './fileIcons';
import { FolderTypeIcon } from './FolderTypeIcon';
import { PlayIcon } from './icons';
import { ImageViewer } from './ImageViewer';
import { useStuckTop } from '../stuckTop';
import './folder-view.css';

// The Files tab's folder previewer (PM-286): what selecting a folder shows. Every entry with its
// size and times, as a grid of thumbnails or a list, filterable by type, name and date, sortable,
// with a marker on what is new or changed since you last looked (asset tracking), and an image
// viewer. The view lives in the address, so it can be linked and survives a reload. Phone first:
// the filters are a bottom sheet, targets are 44px, and only a page of entries is in the page at a
// time.

const PAGE = 120;
/** Pictures bigger than this show an icon in the grid instead of loading the whole file as a thumbnail. */
const THUMB_MAX_BYTES = 25 * 1024 * 1024;
const RANGES: DropdownOption<ModifiedRange>[] = [
  { value: 'any', label: 'Any time' },
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];
const SORTS: DropdownOption<SortKey>[] = [
  { value: 'modified', label: 'Modified' },
  { value: 'name', label: 'Name' },
  { value: 'size', label: 'Size' },
  { value: 'type', label: 'Type' },
];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

export function FolderView({
  projectId,
  dir,
  onOpenFile,
  onOpenDir,
  onClose,
}: {
  projectId: number;
  dir: string;
  onOpenFile: (path: string) => void;
  onOpenDir: (path: string) => void;
  onClose: () => void;
}) {
  const [params, setParams] = useSearchParams();
  // The view comes from the address; with none there, from what was last used in the previewer.
  const saved = useMemo(
    () => (hasViewParams(params) ? null : readSavedView(projectId, dir)),
    [params, projectId, dir],
  );
  const view = useMemo(() => readViewParams(saved ?? params), [saved, params]);
  // Brought into the address too, so the link and a reload show what is on screen; if the address
  // already carries a view, remember it so moving between folders and files keeps it.
  useEffect(() => {
    if (saved)
      setParams((current) => writeViewParams(readViewParams(saved), current), { replace: true });
    else if (hasViewParams(params)) writeSavedView(projectId, dir, view);
  }, [saved, params, projectId, dir, view, setParams]);
  const change = (patch: Partial<FolderViewState>) => {
    const next = { ...view, ...patch };
    writeSavedView(projectId, dir, next);
    setParams((current) => writeViewParams(next, current), { replace: true });
  };

  const [data, setData] = useState<FolderInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const requestGeneration = useRef(0);
  const morePending = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const lastReadAt = useRef(0);
  const forceRefresh = useRef(false);
  const typeKey = view.types.join(',');
  const loadKey = `${projectId}|${dir}|${view.recursive}|${typeKey}|${reload}`;
  const [lastLoadKey, setLastLoadKey] = useState(loadKey);
  if (lastLoadKey !== loadKey) {
    setLastLoadKey(loadKey);
    setLoading(true);
    setLoadingMore(false);
  }
  useEffect(() => {
    let current = true;
    const generation = ++requestGeneration.current;
    morePending.current = false;
    // The list on screen stays while a new one loads (switching recursion, refreshing).
    const types = typeKey ? typeKey.split(',') : undefined;
    const request = forceRefresh.current
      ? api.folderInfo(projectId, dir, view.recursive, undefined, types, true)
      : api.folderInfo(projectId, dir, view.recursive, undefined, types);
    request
      .then(async (next) => {
        if (!current) return;
        const items = new Map(next.items.map((item) => [item.path, item]));
        const publish = () => {
          const all = [...items.values()];
          const files = all.filter((item) => item.kind === 'file');
          setData({
            ...next,
            items: all,
            files: files.length,
            folders: all.length - files.length,
            totalSize: files.reduce((sum, item) => sum + (item.size ?? 0), 0),
            newest: files.reduce<string | null>(
              (latest, item) =>
                item.mtime && (!latest || item.mtime > latest) ? item.mtime : latest,
              null,
            ),
          });
        };
        publish();
        lastReadAt.current = Date.now();
        forceRefresh.current = false;
        setError(null);
        setLoading(false);
        morePending.current = view.recursive && next.nextOffset !== undefined;
        setLoadingMore(morePending.current);
        try {
          while (current && view.recursive && next.nextOffset !== undefined) {
            const offset = next.nextOffset;
            const page = await api.folderInfo(projectId, dir, view.recursive, offset, types);
            if (!current) return;
            if (page.nextOffset !== undefined && page.nextOffset <= offset)
              throw new Error('Folder listing did not advance. Refresh to retry.');
            for (const item of page.items) items.set(item.path, item);
            next = page;
            publish();
          }
        } finally {
          if (current) {
            morePending.current = false;
            setLoadingMore(false);
          }
        }
      })
      .catch((e: Error) => {
        if (!current) return;
        setError(e.message);
        setLoading(false);
      });
    return () => {
      current = false;
      requestGeneration.current = generation + 1;
    };
  }, [projectId, dir, view.recursive, typeKey, reload]);

  useEffect(() => {
    const refresh = () => {
      if (
        document.visibilityState === 'visible' &&
        !morePending.current &&
        Date.now() - lastReadAt.current >= 30_000
      ) {
        lastReadAt.current = Date.now();
        setReload((n) => n + 1);
      }
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);

  const loadMore = async () => {
    if (!data || data.nextOffset === undefined || morePending.current || loading) return;
    const generation = requestGeneration.current;
    morePending.current = true;
    setLoadingMore(true);
    try {
      const next = await api.folderInfo(
        projectId,
        dir,
        view.recursive,
        data.nextOffset,
        typeKey ? typeKey.split(',') : undefined,
      );
      if (generation !== requestGeneration.current) return;
      setData((previous) => {
        if (!previous) return next;
        const items = [
          ...new Map([...previous.items, ...next.items].map((i) => [i.path, i])).values(),
        ];
        const files = items.filter((i) => i.kind === 'file');
        return {
          ...next,
          items,
          files: files.length,
          folders: items.length - files.length,
          totalSize: files.reduce((sum, i) => sum + (i.size ?? 0), 0),
          newest: files.reduce<string | null>(
            (latest, i) => (i.mtime && (!latest || i.mtime > latest) ? i.mtime : latest),
            null,
          ),
          // Scope totals come from the server (PM-390): keep the first page's, they
          // describe the whole scope, not the merged pages.
          total: previous.total ?? next.total,
        };
      });
      setError(null);
      setCount((current) => current + PAGE);
    } catch (e) {
      if (generation === requestGeneration.current) setError((e as Error).message);
    } finally {
      if (generation === requestGeneration.current) {
        morePending.current = false;
        setLoadingMore(false);
      }
    }
  };

  // What changed since the last visit: the moment this folder was last looked at, kept per project and
  // folder. It is read once on arrival and written when the view closes, so the badges show what is new
  // relative to the previous visit; "Mark all seen" moves the line to now.
  const [seenAt, setSeenAt] = useState<number | null>(() => readSeen(projectId, dir));
  // The folder changed under this view (a breadcrumb, a subfolder, the tree): it is not remounted, so
  // the list does not blink and the page does not shorten; what belongs to a folder is switched here.
  const [viewer, setViewer] = useState<number | null>(null);
  const [seenDir, setSeenDir] = useState(dir);
  if (seenDir !== dir) {
    setSeenDir(dir);
    setSeenAt(readSeen(projectId, dir));
    setViewer(null);
    setLoading(true);
  }
  useEffect(() => {
    const save = () => writeSeen(projectId, dir, Date.now());
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      save();
    };
  }, [projectId, dir]);

  const shown = useMemo(
    () => sortItems(applyFilters(data?.items ?? [], view), view.sort, view.descending),
    [data, view],
  );
  const changed = useMemo(
    () => shown.filter((item) => changedSince(item, seenAt) !== null).length,
    [shown, seenAt],
  );
  const images = useMemo(() => shown.filter((item) => typeGroupOf(item) === 'image'), [shown]);

  // A page of entries at a time; a new filter or sort starts again from the top.
  const [count, setCount] = useState(PAGE);
  const viewKey = `${dir}|${params.get('q')}|${params.get('types')}|${params.get('mod')}|${params.get('sort')}|${params.get('order')}|${view.recursive}`;
  const [lastKey, setLastKey] = useState(viewKey);
  if (viewKey !== lastKey) {
    setLastKey(viewKey);
    setCount(PAGE);
  }

  // Phones: the folder's header sticks right under the project's tab bar (--stuck-top).
  const stuckTop = useStuckTop();
  const [sheet, setSheet] = useState(false);
  const modifiedId = useId();
  const sortId = useId();
  const itemsByPath = useMemo(() => new Map(data?.items.map((item) => [item.path, item])), [data]);
  const version = useCallback(
    (path: string) => {
      const item = itemsByPath.get(path);
      return `&v=${encodeURIComponent(`${item?.mtime ?? ''}|${item?.size ?? ''}|${reload}`)}`;
    },
    [itemsByPath, reload],
  );
  const rawUrl = useCallback(
    (path: string) => `${api.projectRawUrl(projectId, path)}${version(path)}`,
    [projectId, version],
  );
  // A video's frame, made once on the server (PM-647), never the video itself.
  const thumbUrl = useCallback(
    (path: string) => `${api.projectVideoThumbUrl(projectId, path)}${version(path)}`,
    [projectId, version],
  );

  const open = (item: FolderItem) => {
    if (item.kind === 'dir') onOpenDir(item.path);
    else if (typeGroupOf(item) === 'image')
      setViewer(images.findIndex((i) => i.path === item.path));
    else onOpenFile(item.path);
  };

  // Arrow keys move between entries like a grid; Enter and Space activate (they are buttons).
  const gridKeys = (event: KeyboardEvent<HTMLElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const cells = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-cell]')];
    const at = cells.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    let next: number;
    if (event.key === 'ArrowRight') next = at + 1;
    else if (event.key === 'ArrowLeft') next = at - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = cells.length - 1;
    else {
      // Down and up: the nearest entry in the next or previous row.
      const box = cells[at]!.getBoundingClientRect();
      const wantDown = event.key === 'ArrowDown';
      const candidates = cells.filter((cell) => {
        const b = cell.getBoundingClientRect();
        return wantDown ? b.top > box.bottom - 2 : b.bottom < box.top + 2;
      });
      const rowTop = wantDown
        ? Math.min(...candidates.map((c) => c.getBoundingClientRect().top))
        : Math.max(...candidates.map((c) => c.getBoundingClientRect().top));
      const row = candidates.filter((c) => Math.abs(c.getBoundingClientRect().top - rowTop) < 2);
      const target = row.sort(
        (a, b) =>
          Math.abs(a.getBoundingClientRect().left - box.left) -
          Math.abs(b.getBoundingClientRect().left - box.left),
      )[0];
      if (!target) return;
      next = cells.indexOf(target);
    }
    cells[Math.max(0, Math.min(cells.length - 1, next))]?.focus();
    event.preventDefault();
  };

  const crumbs = dir ? dir.split('/') : [];
  const active =
    (view.text.trim() ? 1 : 0) +
    view.types.length +
    (view.modified !== 'any' ? 1 : 0) +
    (view.recursive ? 1 : 0);

  return (
    <div className="fv" aria-busy={loading} ref={stuckTop}>
      <div className="files-view-head fv-head">
        <button type="button" className="btn btn-sm files-back" onClick={onClose}>
          ← Files
        </button>
        <nav className="files-crumbs truncate" aria-label="Folder path">
          <button type="button" className="fv-crumb" onClick={() => onOpenDir('')}>
            Project
          </button>
          {crumbs.map((part, i) => {
            const path = crumbs.slice(0, i + 1).join('/');
            return (
              <span key={path}>
                <span className="faint"> / </span>
                {i === crumbs.length - 1 ? (
                  <b>{part}</b>
                ) : (
                  <button type="button" className="fv-crumb" onClick={() => onOpenDir(path)}>
                    {part}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
        <button
          type="button"
          className="btn btn-sm fv-filters-button"
          aria-expanded={sheet}
          onClick={() => setSheet((v) => !v)}
        >
          Filters{active ? ` (${active})` : ''}
        </button>
        <button
          type="button"
          className="btn btn-sm fv-refresh"
          title="Read this folder again"
          onClick={() => {
            forceRefresh.current = true;
            setLoading(true);
            setReload((n) => n + 1);
          }}
        >
          Refresh
        </button>
        <span className="session-view-switch" role="group" aria-label="Layout">
          <button
            type="button"
            aria-pressed={view.view === 'grid'}
            onClick={() => change({ view: 'grid' })}
          >
            Grid
          </button>
          <button
            type="button"
            aria-pressed={view.view === 'list'}
            onClick={() => change({ view: 'list' })}
          >
            List
          </button>
        </span>
      </div>

      {data && (
        <p className="faint fv-summary" role="status">
          {(data.total?.files ?? data.files).toLocaleString()}{' '}
          {(data.total?.files ?? data.files) === 1 ? 'file' : 'files'} ·{' '}
          {(data.total?.folders ?? data.folders).toLocaleString()}{' '}
          {(data.total?.folders ?? data.folders) === 1 ? 'folder' : 'folders'} ·{' '}
          {formatBytes(data.total?.size ?? data.totalSize)}
          {(data.total?.newest ?? data.newest)
            ? ` · newest ${formatRelative((data.total?.newest ?? data.newest)!)}`
            : ''}
          {shown.length !== data.items.length ? ` · showing ${shown.length.toLocaleString()}` : ''}
          {data.total
            ? !data.total.complete
              ? ' · first entries only'
              : ''
            : data.truncated
              ? ' · more entries available'
              : ''}
        </p>
      )}

      <div className="fv-toolbar">
        {seenAt !== null && changed > 0 && (
          <span className="fv-changed">
            <b>{changed}</b> new or changed since you last looked
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const now = Date.now();
                writeSeen(projectId, dir, now);
                setSeenAt(now);
              }}
            >
              Mark all seen
            </button>
          </span>
        )}
      </div>

      {sheet && (
        <button
          type="button"
          className="fv-backdrop"
          aria-label="Close filters"
          onClick={() => setSheet(false)}
        />
      )}
      <div
        className={`fv-controls${sheet ? ' is-open' : ''}`}
        role="search"
        aria-label="Filter this folder"
      >
        <div className="fv-line">
          <input
            type="search"
            className="input fv-search"
            placeholder="Filter by name…"
            aria-label="Filter by name"
            value={view.text}
            onChange={(e) => change({ text: e.target.value })}
          />
          <div className="fv-chips" role="group" aria-label="File types">
            {FILE_GROUPS.map((group) => {
              const on = view.types.includes(group.id);
              return (
                <button
                  key={group.id}
                  type="button"
                  className="fv-chip"
                  aria-pressed={on}
                  onClick={() =>
                    change({
                      types: on
                        ? view.types.filter((t) => t !== group.id)
                        : [...view.types, group.id],
                    })
                  }
                >
                  <FolderTypeIcon type={group.id} />
                  <span>{group.label}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="fv-line fv-line-b">
          <div className="fv-field">
            <label htmlFor={modifiedId}>Modified</label>
            <Dropdown
              id={modifiedId}
              label="Modified"
              value={view.modified}
              options={RANGES}
              onChange={(modified) => change({ modified })}
            />
          </div>
          <div className="fv-field">
            <label htmlFor={sortId}>Sort by</label>
            <div className="fv-sort-control">
              <Dropdown
                id={sortId}
                label="Sort by"
                value={view.sort}
                options={SORTS}
                onChange={(sort) => change({ sort, descending: defaultDescending(sort) })}
              />
              <button
                type="button"
                className="btn btn-icon fv-order"
                title={
                  view.descending
                    ? 'Sorted high to low · switch to low to high'
                    : 'Sorted low to high · switch to high to low'
                }
                aria-label={
                  view.descending
                    ? 'Sorted high to low; switch to low to high'
                    : 'Sorted low to high; switch to high to low'
                }
                onClick={() => change({ descending: !view.descending })}
              >
                {view.descending ? '↓' : '↑'}
              </button>
            </div>
          </div>
          <label className={`fv-check${view.recursive ? ' is-checked' : ''}`}>
            <input
              type="checkbox"
              checked={view.recursive}
              onChange={(e) => change({ recursive: e.target.checked })}
            />
            <span className="fv-check-box" aria-hidden="true">
              <svg width="10" height="10" viewBox="0 0 12 12">
                <path
                  d="M2.5 6.2l2.4 2.3 4.6-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span>Include subfolders</span>
          </label>
          <button
            type="button"
            className="btn fv-reset"
            disabled={!active}
            onClick={() => change({ text: '', types: [], modified: 'any', recursive: false })}
          >
            Clear filters
          </button>
        </div>
        <button type="button" className="btn fv-done" onClick={() => setSheet(false)}>
          Show {shown.length.toLocaleString()}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!data ? (
        !error && <div className="skeleton" style={{ height: 240 }} />
      ) : shown.length === 0 ? (
        <p className="faint files-empty">
          {data.items.length === 0 ? 'This folder is empty.' : 'Nothing matches these filters.'}
        </p>
      ) : (
        <div className={`fv-results${loading ? ' fv-stale' : ''}`} onKeyDown={gridKeys}>
          {view.view === 'grid' ? (
            <ul className="fv-grid" role="list">
              {shown.slice(0, count).map((item) => (
                <GridCell
                  key={item.path}
                  item={item}
                  seenAt={seenAt}
                  rawUrl={rawUrl}
                  thumbUrl={thumbUrl}
                  onOpen={open}
                  showPath={view.recursive}
                />
              ))}
            </ul>
          ) : (
            <div className="fv-list" role="table" aria-label="Entries">
              <div className="fv-row fv-row-head" role="row">
                <span role="columnheader">Name</span>
                <span role="columnheader">Size</span>
                <span role="columnheader">Modified</span>
                <span role="columnheader" className="fv-col-created">
                  Created
                </span>
              </div>
              {shown.slice(0, count).map((item) => (
                <ListRow
                  key={item.path}
                  item={item}
                  seenAt={seenAt}
                  onOpen={open}
                  showPath={view.recursive}
                />
              ))}
            </div>
          )}
          {shown.length > count && (
            <button type="button" className="btn fv-more" onClick={() => setCount((c) => c + PAGE)}>
              Show {Math.min(PAGE, shown.length - count)} more (
              {(shown.length - count).toLocaleString()} left)
            </button>
          )}
        </div>
      )}

      {data?.nextOffset !== undefined && shown.length <= count && (
        <button
          type="button"
          className="btn fv-more"
          disabled={loading || loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? 'Loading more entries…' : 'Load more entries'}
        </button>
      )}

      {viewer !== null && viewer >= 0 && (
        <ImageViewer
          items={images}
          index={viewer}
          rawUrl={rawUrl}
          onIndex={setViewer}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}

function Badge({ item, seenAt }: { item: FolderItem; seenAt: number | null }) {
  const mark = changedSince(item, seenAt);
  return mark ? (
    <span className={`fv-badge fv-badge-${mark}`}>{mark === 'new' ? 'New' : 'Changed'}</span>
  ) : null;
}

const GIT_LABEL: Record<NonNullable<FolderItem['git']>, [string, string]> = {
  modified: ['M', 'Modified since the last commit'],
  added: ['A', 'Staged as new'],
  untracked: ['U', 'Not tracked by git'],
  conflict: ['!', 'Merge conflict'],
};

/** Git's view of an entry, when it differs from the last commit. */
function GitMarker({ item }: { item: FolderItem }) {
  if (!item.git) return null;
  const [letter, text] = GIT_LABEL[item.git];
  return (
    <span className={`fv-git fv-git-${item.git}`} title={text} role="img" aria-label={text}>
      {letter}
    </span>
  );
}

/** "640 × 480" for a picture whose header could be read. */
const dimensions = (item: FolderItem): string =>
  item.width && item.height ? `${item.width} × ${item.height}` : '';

function GridCell({
  item,
  seenAt,
  rawUrl,
  thumbUrl,
  onOpen,
  showPath,
}: {
  item: FolderItem;
  seenAt: number | null;
  rawUrl: (path: string) => string;
  thumbUrl: (path: string) => string;
  onOpen: (item: FolderItem) => void;
  showPath: boolean;
}) {
  const video = item.kind !== 'dir' && mediaKind(item.name) === 'video';
  const canThumb =
    video ||
    (typeGroupOf(item) === 'image' &&
      canPreviewImage(item.name) &&
      (item.size ?? 0) <= THUMB_MAX_BYTES);
  // The failed path, not a flag: a new path renders a new thumbnail without an effect.
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const source = video ? thumbUrl(item.path) : rawUrl(item.path);
  const image = canThumb && failedPath !== source;
  const spec = iconFor(item);
  return (
    <li>
      <button
        type="button"
        className="fv-cell"
        data-cell
        onClick={() => onOpen(item)}
        title={`${item.path}${item.mtime ? `\nModified ${when(item.mtime)}` : ''}${item.ctime ? `\nCreated ${when(item.ctime)}` : ''}`}
      >
        <span className="fv-thumb">
          {image ? (
            <img
              src={source}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              onError={() => setFailedPath(source)}
            />
          ) : (
            <FileTypeIcon spec={spec} size={36} />
          )}
          {image && video && (
            <span className="fv-play" aria-hidden="true">
              <PlayIcon size={12} />
            </span>
          )}
          <Badge item={item} seenAt={seenAt} />
          <GitMarker item={item} />
        </span>
        <span className="fv-name">{item.name}</span>
        <span className="faint fv-meta num">
          {item.kind === 'dir' ? 'Folder' : item.size === null ? '' : formatBytes(item.size)}
          {item.mtime ? ` · ${formatRelative(item.mtime)}` : ''}
        </span>
        {dimensions(item) && <span className="faint fv-meta num">{dimensions(item)}</span>}
        {showPath && item.path !== item.name && (
          <span className="faint fv-meta fv-path">{item.path}</span>
        )}
      </button>
    </li>
  );
}

function ListRow({
  item,
  seenAt,
  onOpen,
  showPath,
}: {
  item: FolderItem;
  seenAt: number | null;
  onOpen: (item: FolderItem) => void;
  showPath: boolean;
}) {
  return (
    <button
      type="button"
      className="fv-row"
      role="row"
      data-cell
      onClick={() => onOpen(item)}
      title={item.path}
    >
      <span className="fv-row-name" role="cell">
        <span className="files-icon" aria-hidden="true">
          <FileTypeIcon spec={iconFor(item)} size={16} />
        </span>
        <span className="truncate">{showPath ? item.path : item.name}</span>
        <Badge item={item} seenAt={seenAt} />
        <GitMarker item={item} />
      </span>
      <span className="num" role="cell">
        {item.kind === 'dir' || item.size === null ? '' : formatBytes(item.size)}
        {dimensions(item) && <span className="faint"> · {dimensions(item)}</span>}
      </span>
      <span className="num" role="cell" title={when(item.mtime)}>
        {formatRelative(item.mtime)}
      </span>
      <span className="num fv-col-created" role="cell" title={when(item.ctime)}>
        {formatRelative(item.ctime)}
      </span>
    </button>
  );
}
