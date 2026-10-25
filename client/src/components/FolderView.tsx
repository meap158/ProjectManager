import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import type { FolderInfo, FolderItem } from '../../../shared/types';
import { api } from '../api';
import { formatBytes, formatRelative } from '../format';
import {
  FILE_GROUPS,
  hasViewParams,
  readSavedView,
  writeSavedView,
  applyFilters,
  changedSince,
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
import { ImageViewer } from './ImageViewer';
import './folder-view.css';

// The Files tab's folder previewer (PM-286): what selecting a folder shows. Every entry with its
// size and times, as a grid of thumbnails or a list, filterable by type, name and date, sortable,
// with a marker on what is new or changed since you last looked (asset tracking), and an image
// viewer. The view lives in the address, so it can be linked and survives a reload. Phone first:
// the filters are a bottom sheet, targets are 44px, and only a page of entries is in the page at a
// time.

const PAGE = 120;
/** Pictures bigger than this show an icon in the grid instead of loading the whole file as a thumbnail. */
const THUMB_MAX_BYTES = 2 * 1024 * 1024;
const RANGES: { id: ModifiedRange; label: string }[] = [
  { id: 'any', label: 'Any time' },
  { id: 'today', label: 'Today' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
];
const SORTS: { id: SortKey; label: string }[] = [
  { id: 'modified', label: 'Modified' },
  { id: 'name', label: 'Name' },
  { id: 'size', label: 'Size' },
  { id: 'type', label: 'Type' },
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
  // The view comes from the address; with none there, from what was last used in this folder.
  const saved = useMemo(
    () => (hasViewParams(params) ? null : readSavedView(projectId, dir)),
    [params, projectId, dir],
  );
  const view = useMemo(() => readViewParams(saved ?? params), [saved, params]);
  // Brought into the address too, so the link and a reload show what is on screen.
  useEffect(() => {
    if (saved)
      setParams((current) => writeViewParams(readViewParams(saved), current), { replace: true });
  }, [saved, setParams]);
  const change = (patch: Partial<FolderViewState>) => {
    const next = { ...view, ...patch };
    writeSavedView(projectId, dir, next);
    setParams((current) => writeViewParams(next, current), { replace: true });
  };

  const [data, setData] = useState<FolderInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    // The list on screen stays while a new one loads (switching recursion, refreshing).
    api
      .folderInfo(projectId, dir, view.recursive)
      .then((next) => {
        if (!current) return;
        setData(next);
        setError(null);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (!current) return;
        setError(e.message);
        setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [projectId, dir, view.recursive, reload]);

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

  const [sheet, setSheet] = useState(false);
  const rawUrl = useCallback((path: string) => api.projectRawUrl(projectId, path), [projectId]);

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
    <div className="fv" aria-busy={loading}>
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
          className="btn btn-sm"
          title="Read this folder again"
          onClick={() => {
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
          {data.files.toLocaleString()} {data.files === 1 ? 'file' : 'files'} ·{' '}
          {data.folders.toLocaleString()} {data.folders === 1 ? 'folder' : 'folders'} ·{' '}
          {formatBytes(data.totalSize)}
          {data.newest ? ` · newest ${formatRelative(data.newest)}` : ''}
          {shown.length !== data.items.length ? ` · showing ${shown.length.toLocaleString()}` : ''}
          {data.truncated ? ' · first entries only (the folder is large)' : ''}
        </p>
      )}

      <div className="fv-toolbar">
        <button
          type="button"
          className="btn btn-sm fv-filters-button"
          aria-expanded={sheet}
          onClick={() => setSheet((v) => !v)}
        >
          Filters{active ? ` (${active})` : ''}
        </button>
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
                  {group.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="fv-line fv-line-b">
          <label className="fv-field">
            <span>Modified</span>
            <select
              className="input"
              value={view.modified}
              onChange={(e) => change({ modified: e.target.value as ModifiedRange })}
            >
              {RANGES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="fv-field">
            <span>Sort by</span>
            <select
              className="input"
              value={view.sort}
              onChange={(e) => {
                const sort = e.target.value as SortKey;
                change({ sort, descending: defaultDescending(sort) });
              }}
            >
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-sm"
            aria-label={
              view.descending
                ? 'Sorted high to low; switch to low to high'
                : 'Sorted low to high; switch to high to low'
            }
            onClick={() => change({ descending: !view.descending })}
          >
            {view.descending ? '↓' : '↑'}
          </button>
          <label className="fv-check">
            <input
              type="checkbox"
              checked={view.recursive}
              onChange={(e) => change({ recursive: e.target.checked })}
            />
            Include subfolders
          </label>
          <button
            type="button"
            className="btn btn-sm fv-reset"
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

      {error ? (
        <div className="error-banner">{error}</div>
      ) : !data ? (
        <div className="skeleton" style={{ height: 240 }} />
      ) : shown.length === 0 ? (
        <p className="faint files-empty">
          {data.items.length === 0 ? 'This folder is empty.' : 'Nothing matches these filters.'}
        </p>
      ) : (
        <div className={loading ? 'fv-stale' : undefined} onKeyDown={gridKeys}>
          {view.view === 'grid' ? (
            <ul className="fv-grid" role="list">
              {shown.slice(0, count).map((item) => (
                <GridCell
                  key={item.path}
                  item={item}
                  seenAt={seenAt}
                  rawUrl={rawUrl}
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
  onOpen,
  showPath,
}: {
  item: FolderItem;
  seenAt: number | null;
  rawUrl: (path: string) => string;
  onOpen: (item: FolderItem) => void;
  showPath: boolean;
}) {
  const image = typeGroupOf(item) === 'image' && (item.size ?? 0) <= THUMB_MAX_BYTES;
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
            <img src={rawUrl(item.path)} alt="" loading="lazy" decoding="async" draggable={false} />
          ) : (
            <FileTypeIcon spec={spec} size={36} />
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
