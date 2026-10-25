import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useSearchParams } from 'react-router';
import { marked } from 'marked';
import type { FilePin, FilePreview, FolderListing, TreeEntry } from '../../../shared/types';
import { api } from '../api';
import { THEME_EVENT } from '../theme';
import { formatBytes, formatRelative } from '../format';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { ConfirmDelete } from './ConfirmDelete';
import { MoreIcon } from './icons';
import { ChevronIcon, FileTypeIcon, iconFor } from './fileIcons';
import './project-files.css';

// The project page's Files tab (PM-252): a VS Code style explorer. The tree loads one folder at
// a time; git-ignored entries are greyed. Previews: Markdown and HTML render in a sandboxed
// frame (no scripts, no access to this app), images show as images, other text with line
// numbers. Read only. The open file is in the URL (?tab=files&file=…), so it can be linked.

/** More lines than this are cut in the source view (the DOM, not the file, is the limit). */
const MAX_LINES = 5_000;
const RENDERED = new Set(['md', 'markdown', 'mdx', 'html', 'htm']);

const extOf = (p: string) => /\.([^./]+)$/.exec(p)?.[1]?.toLowerCase() ?? '';
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** What the Files context menu can do with one entry. */
export type FileCommand =
  | 'open'
  | 'open-system'
  | 'reveal'
  | 'copy-path'
  | 'copy-relative'
  | 'pin-project'
  | 'pin-all'
  | 'unpin-project'
  | 'unpin-all'
  | 'rename';

/** Whether an entry is already pinned, in each scope (PM-284). */
export interface PinState {
  project: boolean;
  all: boolean;
}

/** The menu for one entry (pure, so the labels and order are testable). */
export function fileMenuItems(
  entry: TreeEntry,
  isOpen: boolean,
  pinned: PinState = { project: false, all: false },
): ContextMenuItem<FileCommand>[] {
  return [
    {
      command: 'open',
      label:
        entry.kind === 'dir' ? (isOpen ? 'Collapse folder' : 'Expand folder') : 'Open in preview',
    },
    {
      command: 'open-system',
      label:
        entry.kind === 'file' && /\.(bat|cmd)$/i.test(entry.name)
          ? 'Run in terminal…'
          : 'Open in system app',
    },
    { command: 'reveal', label: 'Reveal in file manager' },
    { command: 'copy-path', label: 'Copy path', divider: true },
    { command: 'copy-relative', label: 'Copy relative path' },
    {
      command: pinned.project ? 'unpin-project' : 'pin-project',
      label: pinned.project ? 'Unpin from this project' : 'Pin to this project',
      divider: true,
    },
    {
      command: pinned.all ? 'unpin-all' : 'pin-all',
      label: pinned.all ? 'Unpin from all projects' : 'Pin to all projects (this path)',
    },
    { command: 'rename', label: 'Rename…', divider: true },
  ];
}

/** An absolute path in the project's own style (a Windows path gets backslashes, else slashes). */
export function absolutePath(projectPath: string, rel: string): string {
  const BACKSLASH = String.fromCharCode(92);
  const sep = projectPath.includes(BACKSLASH) && !projectPath.includes('/') ? BACKSLASH : '/';
  const root = projectPath.replace(/[/\\]+$/, '');
  return rel ? `${root}${sep}${rel.split('/').join(sep)}` : root;
}

/** "a/b" after "a" became "z" → "z/b"; other paths come back unchanged. */
export function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Not a secure page (the LAN address over http): fall back to a hidden field.
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand('copy');
    field.remove();
    return ok;
  }
}

/** The root and every folder above a file ("a/b/c.ts" → "", "a", "a/b"). */
export function foldersTo(file: string | null): string[] {
  const parts = file ? file.split('/').slice(0, -1) : [];
  return ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))];
}

interface Row {
  entry: TreeEntry;
  level: number;
}

/**
 * Focuses a tree row without the browser's own scroll (which can move the page and the tree), then
 * scrolls the tree only as far as needed to show it: a visible row never moves (PM-268).
 */
function focusQuietly(row: HTMLElement) {
  row.focus({ preventScroll: true });
  row.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

export function ProjectFiles({
  projectId,
  projectPath,
}: {
  projectId: number;
  /** The project's folder on disk, for "Copy path". */
  projectPath?: string;
}) {
  const [params, setParams] = useSearchParams();
  const openFile = params.get('file');
  const [folders, setFolders] = useState<Map<string, FolderListing>>(new Map());
  // Open: the root, and the folders leading to a linked file.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(foldersTo(openFile)));
  const [focused, setFocused] = useState<string | null>(openFile);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef({ text: '', at: 0 });
  const [pins, setPins] = useState<FilePin[]>([]);
  const [pinsOpen, setPinsOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('pm.files.pinsOpen') !== '0';
    } catch {
      return true;
    }
  });
  const [pinMenu, setPinMenu] = useState<{ id: number; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [launcher, setLauncher] = useState<TreeEntry | null>(null);

  const say = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((now) => (now === text ? null : now)), 2000);
  };
  /** Puts focus back on a row (after the menu or a rename closes). */
  const focusRow = (path: string) =>
    setTimeout(() => {
      const rows = treeRef.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [];
      const row = [...rows].find((r) => r.dataset.path === path);
      if (row) focusQuietly(row);
    }, 0);

  const loadPins = useCallback(async () => {
    try {
      setPins((await api.filePins(projectId)).pins);
    } catch {
      // Pins are a convenience: the tree keeps working without them.
    }
  }, [projectId]);
  useEffect(() => {
    let current = true;
    api
      .filePins(projectId)
      .then((result) => current && setPins(result.pins))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [projectId]);

  const load = useCallback(
    async (path: string) => {
      try {
        const listing = await api.projectFolder(projectId, path);
        setFolders((prev) => new Map(prev).set(path, listing));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [projectId],
  );

  // Reads the folders open at first show (later ones load as they're expanded).
  const firstOpen = useRef(expanded);
  useEffect(() => {
    for (const path of firstOpen.current) void load(path);
  }, [load]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const needle = filter.trim().toLowerCase();
    const matches = (entry: TreeEntry): boolean => {
      if (!needle) return true;
      if (entry.name.toLowerCase().includes(needle)) return true;
      if (entry.kind !== 'dir') return false;
      return folders.get(entry.path)?.entries.some(matches) ?? false;
    };
    const walk = (path: string, level: number) => {
      for (const entry of folders.get(path)?.entries ?? []) {
        if (!matches(entry)) continue;
        out.push({ entry, level });
        if (
          entry.kind === 'dir' &&
          (expanded.has(entry.path) || (needle && folders.has(entry.path)))
        )
          walk(entry.path, level + 1);
      }
    };
    walk('', 1);
    return out;
  }, [folders, expanded, filter]);

  const toggle = (entry: TreeEntry, open?: boolean) => {
    const next = new Set(expanded);
    const willOpen = open ?? !next.has(entry.path);
    if (willOpen) {
      next.add(entry.path);
      if (!folders.has(entry.path)) void load(entry.path);
    } else next.delete(entry.path);
    setExpanded(next);
  };

  const select = (entry: TreeEntry) => {
    setFocused(entry.path);
    if (entry.kind === 'dir') toggle(entry);
    else setParams((p) => ({ ...Object.fromEntries(p), tab: 'files', file: entry.path }));
  };

  const entryAt = (path: string) => rows.find((r) => r.entry.path === path)?.entry;

  const pinStateOf = (path: string): PinState => ({
    project: pins.some((p) => p.path === path && p.scope === 'project'),
    all: pins.some((p) => p.path === path && p.scope === 'all'),
  });

  /** Shows a pinned item in the tree: opens the folders above it, then the file or folder. */
  const openPin = async (pin: FilePin) => {
    if (!pin.kind) {
      say('This project has no such file or folder');
      return;
    }
    const above = foldersTo(`${pin.path}/x`).filter((p) => pin.kind === 'dir' || p !== pin.path);
    setExpanded(
      (prev) => new Set([...prev, ...above.filter((p) => p !== pin.path || pin.kind === 'dir')]),
    );
    await Promise.all(above.filter((p) => !folders.has(p)).map((p) => load(p)));
    setFocused(pin.path);
    if (pin.kind === 'file')
      setParams((q) => ({ ...Object.fromEntries(q), tab: 'files', file: pin.path }));
    focusRow(pin.path);
  };

  const togglePins = () => {
    setPinsOpen((open) => {
      try {
        localStorage.setItem('pm.files.pinsOpen', open ? '0' : '1');
      } catch {
        // Not remembered; fine.
      }
      return !open;
    });
  };

  /** Moves a pin within its scope (the Pinned list is project pins, then all-project pins). */
  const movePin = async (pin: FilePin, direction: 'up' | 'down') => {
    try {
      await api.moveFilePin(pin.id, direction);
      await loadPins();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const run = async (command: FileCommand, entry: TreeEntry) => {
    setError(null);
    try {
      switch (command) {
        case 'open':
          select(entry);
          break;
        case 'open-system':
          if (entry.kind === 'file' && /\.(bat|cmd)$/i.test(entry.name)) {
            setLauncher(entry);
            return;
          }
          await api.openProjectFile(projectId, entry.path, 'open');
          break;
        case 'reveal':
          await api.openProjectFile(projectId, entry.path, 'reveal');
          break;
        case 'copy-path':
        case 'copy-relative': {
          const text =
            command === 'copy-relative' || !projectPath
              ? entry.path
              : absolutePath(projectPath, entry.path);
          say((await copyText(text)) ? 'Copied to the clipboard' : 'Could not copy');
          break;
        }
        case 'pin-project':
        case 'pin-all':
          await api.pinFile(projectId, entry.path, command === 'pin-all' ? 'all' : 'project');
          await loadPins();
          say(command === 'pin-all' ? 'Pinned in every project with this path' : 'Pinned');
          break;
        case 'unpin-project':
        case 'unpin-all': {
          const scope = command === 'unpin-all' ? 'all' : 'project';
          const pin = pins.find((p) => p.path === entry.path && p.scope === scope);
          if (pin) await api.unpinFile(pin.id);
          await loadPins();
          say('Unpinned');
          break;
        }
        case 'rename':
          setRenaming(entry.path);
          return;
      }
    } catch (e) {
      setError((e as Error).message);
    }
    focusRow(entry.path);
  };

  /** Renames in place; the tree, the open file and the address follow the new name. */
  const submitRename = async (entry: TreeEntry, name: string) => {
    setRenaming(null);
    if (name === entry.name) return focusRow(entry.path);
    setError(null);
    try {
      const { path: next } = await api.renameProjectFile(projectId, entry.path, name);
      const old = entry.path;
      setFolders((prev) => {
        const kept = new Map<string, FolderListing>();
        for (const [key, listing] of prev) {
          // The renamed folder's cached listings are stale; its parent is read again below.
          if (key !== old && !key.startsWith(`${old}/`) && key !== parentOf(old))
            kept.set(key, listing);
        }
        return kept;
      });
      setExpanded((prev) => new Set([...prev].map((p) => remapPath(p, old, next))));
      setFocused(next);
      if (openFile && remapPath(openFile, old, next) !== openFile)
        setParams((q) => ({ ...Object.fromEntries(q), file: remapPath(openFile, old, next) }), {
          replace: true,
        });
      await load(parentOf(old));
      for (const p of expanded) {
        if (p === old || p.startsWith(`${old}/`)) void load(remapPath(p, old, next));
      }
      say(`Renamed to ${name}`);
      focusRow(next);
    } catch (e) {
      setError((e as Error).message);
      focusRow(entry.path);
    }
  };

  const openMenuFor = (path: string, x: number, y: number) => {
    setFocused(path);
    setMenu({ path, x, y });
  };

  // Roving focus: the focused row is the one tab stop; arrow keys move it (WAI-ARIA tree).
  useEffect(() => {
    if (!focused) return;
    // Compared, not put in a selector: file names can hold any character.
    const el = [...(treeRef.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].find(
      (row) => row.dataset.path === focused,
    );
    if (el && el !== document.activeElement && treeRef.current?.contains(document.activeElement))
      focusQuietly(el);
  }, [focused, rows]);

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    // Nothing focused yet: the first row is the tab stop, so keys act from there.
    const current = focused ?? rows[0]?.entry.path;
    const index = rows.findIndex((r) => r.entry.path === current);
    const row = rows[index];
    const move = (i: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (target) setFocused(target.entry.path);
    };
    // Alt+P pins the row to this project, Alt+Shift+P to every project (toggling), as VS Code's
    // own keyboard-first tree does for its commands. Alt keeps it out of type-ahead.
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'p' && row) {
      const state = pinStateOf(row.entry.path);
      const all = e.shiftKey;
      void run(
        all
          ? state.all
            ? 'unpin-all'
            : 'pin-all'
          : state.project
            ? 'unpin-project'
            : 'pin-project',
        row.entry,
      );
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        move(index + 1);
        break;
      case 'ArrowUp':
        move(index - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows.length - 1);
        break;
      case 'ArrowRight':
        if (row?.entry.kind === 'dir') {
          if (!expanded.has(row.entry.path)) toggle(row.entry, true);
          else move(index + 1);
        }
        break;
      case 'ArrowLeft':
        if (row?.entry.kind === 'dir' && expanded.has(row.entry.path)) toggle(row.entry, false);
        else if (row) setFocused(parentOf(row.entry.path) || row.entry.path);
        break;
      case 'Enter':
      case ' ':
        if (row) select(row.entry);
        break;
      case 'F2':
        if (row) setRenaming(row.entry.path);
        break;
      case 'ContextMenu':
      case 'F10': {
        if (e.key === 'F10' && !e.shiftKey) return;
        const el = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-path]')].find(
          (item) => item.dataset.path === row?.entry.path,
        );
        const box = el?.getBoundingClientRect();
        if (row && box) openMenuFor(row.entry.path, box.left + 24, box.bottom);
        break;
      }
      default: {
        // Type-ahead, as in VS Code: letters typed quickly jump to the next visible row whose name
        // starts with them (a repeated letter cycles). Never inside the rename box.
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
        if ((e.target as HTMLElement).closest('input, textarea')) return;
        const now = e.timeStamp;
        const typed = typeahead.current;
        typed.text = now - typed.at > 700 ? e.key.toLowerCase() : typed.text + e.key.toLowerCase();
        typed.at = now;
        const cycling = typed.text.length > 1 && [...typed.text].every((c) => c === typed.text[0]);
        const needle = cycling ? typed.text[0]! : typed.text;
        const from = cycling || typed.text.length === 1 ? index + 1 : index;
        const order = [...rows.slice(from), ...rows.slice(0, from)];
        const hit = order.find((r) => r.entry.name.toLowerCase().startsWith(needle));
        if (hit) setFocused(hit.entry.path);
        break;
      }
    }
    e.preventDefault();
  };

  const refresh = () => {
    setError(null);
    for (const path of expanded) void load(path);
  };

  const root = folders.get('');
  return (
    <div className={`project-files${openFile ? ' has-file' : ''}`}>
      <section className="panel files-tree-panel" aria-label="Files">
        <div className="files-toolbar">
          <input
            type="search"
            className="input files-filter"
            placeholder="Filter files…"
            aria-label="Filter files in open folders"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            onClick={refresh}
            title="Read the open folders again"
          >
            Refresh
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setExpanded(new Set(['']))}
            title="Collapse all folders"
          >
            Collapse
          </button>
        </div>
        {error && <div className="error-banner">{error}</div>}
        {pins.length > 0 && (
          <section className="files-pins" aria-label="Pinned">
            <button
              type="button"
              className="files-pins-head"
              aria-expanded={pinsOpen}
              onClick={togglePins}
            >
              <span className={`files-chevron${pinsOpen ? ' is-open' : ''}`} aria-hidden="true">
                <ChevronIcon size={12} />
              </span>
              Pinned <span className="faint num">{pins.length}</span>
            </button>
            {pinsOpen && (
              <ul className="files-pin-list">
                {pins.map((pin) => {
                  const name = pin.path.split('/').pop() ?? pin.path;
                  return (
                    <li key={pin.id} className={`files-pin${pin.kind ? '' : ' is-missing'}`}>
                      <button
                        type="button"
                        className="files-pin-open"
                        onClick={() => void openPin(pin)}
                        title={pin.kind ? pin.path : `${pin.path} (not in this project)`}
                      >
                        <span className="files-icon" aria-hidden="true">
                          <FileTypeIcon
                            spec={iconFor({ name, kind: pin.kind === 'dir' ? 'dir' : 'file' })}
                            size={16}
                          />
                        </span>
                        <span className="files-name">{name}</span>
                        {pin.path !== name && (
                          <span className="faint files-meta files-pin-path">{pin.path}</span>
                        )}
                        {pin.scope === 'all' && <span className="files-pin-badge">All</span>}
                        {!pin.kind && <span className="faint files-meta">missing</span>}
                      </button>
                      <button
                        type="button"
                        className="files-more"
                        aria-label={`Actions for pinned ${name}`}
                        aria-haspopup="menu"
                        onClick={(e) => {
                          const box = e.currentTarget.getBoundingClientRect();
                          setPinMenu({ id: pin.id, x: box.right - 8, y: box.bottom });
                        }}
                      >
                        <MoreIcon size={14} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
        {notice && (
          <p className="faint files-notice" role="status">
            {notice}
          </p>
        )}
        {!root ? (
          <div className="skeleton" style={{ height: 160 }} />
        ) : rows.length === 0 ? (
          <p className="faint files-empty">
            {filter ? 'No matches in the open folders.' : 'This folder is empty.'}
          </p>
        ) : (
          <ul
            className="files-tree"
            role="tree"
            aria-label="Project files"
            ref={treeRef}
            onKeyDown={onKeyDown}
          >
            {rows.map(({ entry, level }) => {
              const isOpen = entry.kind === 'dir' && expanded.has(entry.path);
              const isCurrent = entry.path === openFile;
              const tabStop = (focused ?? rows[0]?.entry.path) === entry.path;
              return (
                <li
                  key={entry.path}
                  role="treeitem"
                  data-path={entry.path}
                  aria-level={level}
                  aria-expanded={entry.kind === 'dir' ? isOpen : undefined}
                  aria-selected={isCurrent}
                  tabIndex={tabStop ? 0 : -1}
                  className={`files-row${entry.ignored ? ' is-ignored' : ''}${isCurrent ? ' is-current' : ''}`}
                  // The indent step is CSS (--depth), so touch screens can widen it.
                  style={{ '--depth': level - 1 } as CSSProperties}
                  onClick={() => select(entry)}
                  onFocus={() => setFocused(entry.path)}
                  onContextMenu={(e: MouseEvent) => {
                    e.preventDefault();
                    openMenuFor(entry.path, e.clientX, e.clientY);
                  }}
                  title={entry.ignored ? `${entry.path} (ignored by git)` : entry.path}
                >
                  <span
                    className={`files-chevron${isOpen ? ' is-open' : ''}`}
                    aria-hidden="true"
                    // A wide target on its own: on touch the caret toggles, the name opens.
                    onClick={(e) => {
                      if (entry.kind !== 'dir') return;
                      e.stopPropagation();
                      setFocused(entry.path);
                      toggle(entry);
                    }}
                  >
                    {entry.kind === 'dir' && <ChevronIcon size={12} />}
                  </span>
                  <span className="files-icon" aria-hidden="true">
                    <FileTypeIcon spec={iconFor(entry, isOpen)} size={16} />
                  </span>
                  {renaming === entry.path ? (
                    <RenameField
                      name={entry.name}
                      onSubmit={(name) => void submitRename(entry, name)}
                      onCancel={() => {
                        setRenaming(null);
                        focusRow(entry.path);
                      }}
                    />
                  ) : (
                    <span className="files-name">{entry.name}</span>
                  )}
                  {entry.symlink && <span className="faint files-meta">link</span>}
                  {entry.kind === 'file' && entry.size !== null && (
                    <span className="faint files-meta num">{formatBytes(entry.size)}</span>
                  )}
                  <button
                    type="button"
                    className="files-more"
                    tabIndex={-1}
                    aria-label={`Actions for ${entry.name}`}
                    aria-haspopup="menu"
                    onClick={(e) => {
                      e.stopPropagation();
                      const box = e.currentTarget.getBoundingClientRect();
                      openMenuFor(entry.path, box.right - 8, box.bottom);
                    }}
                  >
                    <MoreIcon size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {[...folders.values()].some((f) => f.truncated) && (
          <p className="faint files-empty">
            Some folders have more entries than shown (5,000 max).
          </p>
        )}
      </section>
      {launcher && (
        <ConfirmDelete
          hideTrigger
          open
          tone="primary"
          icon={null}
          label={`Run ${launcher.name}`}
          heading={`Run ${launcher.name} in terminal?`}
          message={`Runs ${launcher.path} on this computer, with its containing folder as the working directory.`}
          confirmLabel="Run in terminal"
          onDismiss={() => {
            focusRow(launcher.path);
            setLauncher(null);
          }}
          onConfirm={async () => {
            try {
              await api.openProjectFile(projectId, launcher.path, 'run');
              say(`Launched ${launcher.name}`);
            } catch (error) {
              setError((error as Error).message);
            }
          }}
        />
      )}
      {pinMenu &&
        pins.find((p) => p.id === pinMenu.id) &&
        (() => {
          const pin = pins.find((p) => p.id === pinMenu.id)!;
          const sameScope = pins.filter((p) => p.scope === pin.scope);
          const at = sameScope.findIndex((p) => p.id === pin.id);
          return (
            <ContextMenu
              label={`Actions for pinned ${pin.path}`}
              x={pinMenu.x}
              y={pinMenu.y}
              items={[
                { command: 'open', label: pin.kind === 'dir' ? 'Show in tree' : 'Open in preview' },
                { command: 'up', label: 'Move up', disabled: at <= 0, divider: true },
                { command: 'down', label: 'Move down', disabled: at >= sameScope.length - 1 },
                { command: 'unpin', label: 'Unpin', divider: true },
              ]}
              onClose={() => setPinMenu(null)}
              onPick={(command) => {
                setPinMenu(null);
                if (command === 'open') void openPin(pin);
                else if (command === 'up' || command === 'down') void movePin(pin, command);
                else
                  void api
                    .unpinFile(pin.id)
                    .then(loadPins)
                    .catch((e: Error) => setError(e.message));
              }}
            />
          );
        })()}
      {menu && entryAt(menu.path) && (
        <ContextMenu
          label={`Actions for ${entryAt(menu.path)!.name}`}
          x={menu.x}
          y={menu.y}
          items={fileMenuItems(entryAt(menu.path)!, expanded.has(menu.path), pinStateOf(menu.path))}
          onClose={() => {
            setMenu(null);
            focusRow(menu.path);
          }}
          onPick={(command) => {
            const entry = entryAt(menu.path)!;
            setMenu(null);
            void run(command, entry);
          }}
        />
      )}
      <section className="panel files-preview-panel" aria-label="Preview">
        {openFile ? (
          <FileView
            key={openFile}
            projectId={projectId}
            path={openFile}
            onClose={() =>
              setParams((p) => {
                const next = Object.fromEntries(p);
                delete next.file;
                return next;
              })
            }
          />
        ) : (
          <p className="faint files-empty">Choose a file to preview it.</p>
        )}
      </section>
    </div>
  );
}

/**
 * The name field of a row being renamed (VS Code style): the name without its extension is
 * selected, Enter renames, Escape cancels, and leaving the field cancels too, so a rename only
 * happens on purpose. Keys stay in the field instead of moving through the tree.
 */
function RenameField({
  name,
  onSubmit,
  onCancel,
}: {
  name: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = name.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [name]);
  const finish = (submit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (submit) onSubmit(ref.current?.value ?? name);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      className="input files-rename"
      defaultValue={name}
      aria-label={`New name for ${name}`}
      spellCheck={false}
      autoComplete="off"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(false)}
    />
  );
}

function FileView({
  projectId,
  path,
  onClose,
}: {
  projectId: number;
  path: string;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ext = extOf(path);
  const [rendered, setRendered] = useState(RENDERED.has(ext));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.projectFile(projectId, path).then(setPreview, (e: Error) => setError(e.message));
  }, [projectId, path]);

  const crumbs = path.split('/');
  return (
    <div className="files-view">
      <div className="files-view-head">
        <button type="button" className="btn btn-sm files-back" onClick={onClose}>
          ← Files
        </button>
        <span className="files-crumbs truncate" title={path}>
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 && <span className="faint"> / </span>}
              {i === crumbs.length - 1 ? <b>{c}</b> : c}
            </span>
          ))}
        </span>
        {preview && (
          <span className="faint files-meta num">
            {formatBytes(preview.size)} · {formatRelative(preview.mtime)}
          </span>
        )}
        <span className="actions">
          {preview?.kind === 'text' && RENDERED.has(ext) && (
            <span className="session-view-switch" role="group" aria-label="View">
              <button type="button" aria-pressed={rendered} onClick={() => setRendered(true)}>
                Preview
              </button>
              <button type="button" aria-pressed={!rendered} onClick={() => setRendered(false)}>
                Source
              </button>
            </span>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              void navigator.clipboard?.writeText(path).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy path'}
          </button>
        </span>
      </div>
      {error ? (
        <div className="error-banner">{error}</div>
      ) : !preview ? (
        <div className="skeleton" style={{ height: 240 }} />
      ) : preview.kind === 'image' ? (
        <div className="files-image">
          <img src={api.projectRawUrl(projectId, path)} alt={path} />
        </div>
      ) : preview.kind === 'binary' ? (
        <p className="faint files-empty">Binary file: no preview.</p>
      ) : preview.kind === 'too-large' ? (
        <p className="faint files-empty">
          Too large to preview ({formatBytes(preview.size)}; 2 MB max).
        </p>
      ) : preview.kind !== 'text' ? null : rendered && RENDERED.has(ext) ? (
        <RenderedFrame
          projectId={projectId}
          path={path}
          source={preview.content}
          markdown={ext !== 'html' && ext !== 'htm'}
        />
      ) : (
        <SourceView content={preview.content} />
      )}
    </div>
  );
}

function SourceView({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  const shown = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES) : lines;
  return (
    <>
      {lines.length > MAX_LINES && (
        <p className="faint files-empty">
          Showing the first {MAX_LINES.toLocaleString()} of {lines.length.toLocaleString()} lines.
        </p>
      )}
      <pre className="files-source" tabIndex={0} aria-label="File contents">
        {shown.map((line, i) => (
          <div key={i} className="files-line">
            <span className="files-ln" aria-hidden="true">
              {i + 1}
            </span>
            <code>{line || ' '}</code>
          </div>
        ))}
      </pre>
    </>
  );
}

/** The app's resolved theme ("light" / "dark"), following switches so a frame can redraw. */
function useDocumentTheme(): string {
  const read = () => document.documentElement.dataset.theme ?? 'light';
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const update = () => setTheme(read());
    window.addEventListener(THEME_EVENT, update);
    return () => window.removeEventListener(THEME_EVENT, update);
  }, []);
  return theme;
}

/**
 * Markdown (rendered) or an HTML file, in a frame that can't run scripts or reach this app
 * (sandbox without scripts or same-origin, plus a CSP). Relative images and styles load from
 * the project; links open in a new tab.
 */
function RenderedFrame({
  projectId,
  path,
  source,
  markdown,
}: {
  projectId: number;
  path: string;
  source: string;
  markdown: boolean;
}) {
  const theme = useDocumentTheme();
  const doc = useMemo(() => {
    const dir = parentOf(path);
    const rawBase = `${location.origin}/api/projects/${projectId}/raw?path=`;
    const css = getComputedStyle(document.documentElement);
    const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    // A frame's scrollbar is the page's own, so it stayed light inside the dark app. In dark,
    // only the scrollbar follows the app (an HTML file keeps its own colours otherwise), like
    // the Preview browser's framed pages.
    const scrollbar =
      theme === 'dark'
        ? `<style>html{scrollbar-color:${color('--border-strong', '#3d3d39')} ${color('--surface', '#1a1a19')}}</style>`
        : '';
    const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${location.origin} https: data:; style-src 'unsafe-inline' ${location.origin}; font-src ${location.origin} data:"><base target="_blank">${scrollbar}`;
    const pageBase = `${location.origin}/projects/${projectId}`;
    if (!markdown) return withBase(source, head, rawBase, dir, pageBase);
    const body = marked.parse(source, { async: false, gfm: true }) as string;
    // Rendered Markdown wears the app's colours throughout, so its form controls match too.
    const style = `<style>
      html{color-scheme:${theme === 'dark' ? 'dark' : 'light'}}
      body{font:14px/1.6 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:16px 20px;color:${color('--text', '#222')};background:${color('--surface', '#fff')}}
      a{color:${color('--accent', '#3b5bdb')}} img{max-width:100%}
      pre,code{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;background:${color('--surface-2', '#f4f4f4')};border-radius:4px}
      pre{padding:10px;overflow:auto} code{padding:1px 4px} pre code{padding:0}
      table{border-collapse:collapse} th,td{border:1px solid ${color('--border', '#ddd')};padding:4px 8px}
      blockquote{margin:0;padding-left:12px;border-left:3px solid ${color('--border', '#ddd')};color:${color('--text-2', '#555')}}
      h1,h2{border-bottom:1px solid ${color('--border', '#ddd')};padding-bottom:4px}
    </style>`;
    return `<!doctype html><html><head>${head}${style}</head><body>${rewriteRelative(body, rawBase, dir, pageBase)}</body></html>`;
  }, [projectId, path, source, markdown, theme]);
  return (
    <iframe
      className="files-frame"
      title={`Preview of ${path}`}
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
      referrerPolicy="no-referrer"
      srcDoc={doc}
    />
  );
}

/** A path relative to a project folder, with "." and ".." resolved (null if it leaves). */
export function joinPath(dir: string, rel: string): string | null {
  const out = dir ? dir.split('/') : [];
  for (const part of rel.split(/[?#]/)[0]!.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(decodeURIComponent(part));
  }
  return out.join('/');
}

/** Relative images and stylesheets load the project's own files (other links stay as written). */
/**
 * Where a link inside a previewed page should go. A relative link (or one starting with "/", which
 * like GitHub means the project's root) names another file of this project, so it becomes this app's
 * own address for that file: left as written, the browser resolved it against the app's page and
 * landed on /projects/<name>. Web addresses, mail links and in-page "#" links are left alone
 * (null); a path that would leave the project becomes an inert "#"; a folder opens the Files tab.
 */
export function projectLinkHref(url: string, dir: string, pageBase: string): string | null {
  const value = url.trim();
  if (
    !value ||
    value.startsWith('#') ||
    value.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  )
    return null;
  const path = value.split(/[?#]/)[0]!;
  const target = path.startsWith('/') ? joinPath('', path.slice(1)) : joinPath(dir, path);
  if (target === null) return '#';
  if (target === '' || path.endsWith('/')) return `${pageBase}?tab=files`;
  return `${pageBase}?tab=files&file=${encodeURIComponent(target)}`;
}

export function rewriteRelative(
  html: string,
  rawBase: string,
  dir: string,
  pageBase?: string,
): string {
  const asset = (url: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(url)) return url;
    const target = joinPath(dir, url);
    return target === null ? url : `${rawBase}${encodeURIComponent(target)}`;
  };
  // <picture>/<img srcset>: "url 2x, url 640w" candidates (a README's light/dark images).
  const withSrcset = html.replace(/\bsrcset="([^"]+)"/gi, (_m, set: string) => {
    const candidates = set.split(',').map((candidate) => {
      const [url = '', ...descriptor] = candidate.trim().split(/\s+/);
      return [asset(url), ...descriptor].join(' ');
    });
    return `srcset="${candidates.join(', ')}"`;
  });
  // Links to other files of the project open that file in the Files tab, in this same tab: the
  // anchor targets the top window, which the frame may only do on a click (sandbox
  // allow-top-navigation-by-user-activation; the frame runs no scripts, so nothing else can
  // navigate). An inert link stays in the frame; web and mail links keep the base's new-tab target.
  const withLinks = pageBase
    ? withSrcset.replace(/<a\b[^>]*>/gi, (tag) => {
        const found = /\shref="([^"]*)"/i.exec(tag);
        const href = found ? projectLinkHref(found[1]!, dir, pageBase) : null;
        if (href === null) return tag;
        const base = tag
          .replace(/\shref="[^"]*"/i, ` href="${href}"`)
          .replace(/\starget="[^"]*"/i, '')
          .replace(/\/?>$/, '');
        return `${base} target="${href === '#' ? '_self' : '_top'}">`;
      })
    : withSrcset;
  return withLinks.replace(
    /\b(src|href)="(?![a-z][a-z0-9+.-]*:|#|\/\/|\/)([^"]+)"/gi,
    (match, attr: string, url: string) => {
      const isAsset = attr.toLowerCase() === 'src' || /\.css$/i.test(url.split(/[?#]/)[0]!);
      const target = isAsset ? joinPath(dir, url) : null;
      return target === null ? match : `${attr}="${rawBase}${encodeURIComponent(target)}"`;
    },
  );
}

/** An HTML file with the CSP and base injected into its head, and relative assets rewritten. */
function withBase(
  html: string,
  head: string,
  rawBase: string,
  dir: string,
  pageBase: string,
): string {
  const rewritten = rewriteRelative(html, rawBase, dir, pageBase);
  return /<head[^>]*>/i.test(rewritten)
    ? rewritten.replace(/<head[^>]*>/i, (m) => `${m}${head}`)
    : `<!doctype html><html><head>${head}</head><body>${rewritten}</body></html>`;
}
