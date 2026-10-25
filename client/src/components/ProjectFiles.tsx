import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { marked } from 'marked';
import type { FilePreview, FolderListing, TreeEntry } from '../../../shared/types';
import { api } from '../api';
import { formatBytes, formatRelative } from '../format';
import { FoldersIcon, PageIcon } from './icons';
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

/** The root and every folder above a file ("a/b/c.ts" → "", "a", "a/b"). */
export function foldersTo(file: string | null): string[] {
  const parts = file ? file.split('/').slice(0, -1) : [];
  return ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))];
}

interface Row {
  entry: TreeEntry;
  level: number;
}

export function ProjectFiles({ projectId }: { projectId: number }) {
  const [params, setParams] = useSearchParams();
  const openFile = params.get('file');
  const [folders, setFolders] = useState<Map<string, FolderListing>>(new Map());
  // Open: the root, and the folders leading to a linked file.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(foldersTo(openFile)));
  const [focused, setFocused] = useState<string | null>(openFile);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);

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

  // Roving focus: the focused row is the one tab stop; arrow keys move it (WAI-ARIA tree).
  useEffect(() => {
    if (!focused) return;
    // Compared, not put in a selector: file names can hold any character.
    const el = [...(treeRef.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])].find(
      (row) => row.dataset.path === focused,
    );
    if (el && treeRef.current?.contains(document.activeElement)) el.focus();
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
      default:
        return;
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
            placeholder="Filter open folders…"
            aria-label="Filter files in open folders"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={refresh}
            title="Read the open folders again"
          >
            Refresh
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setExpanded(new Set(['']))}
            title="Collapse all folders"
          >
            Collapse
          </button>
        </div>
        {error && <div className="error-banner">{error}</div>}
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
                  style={{ paddingLeft: 6 + (level - 1) * 14 }}
                  onClick={() => select(entry)}
                  onFocus={() => setFocused(entry.path)}
                  title={entry.ignored ? `${entry.path} (ignored by git)` : entry.path}
                >
                  <span className="files-chevron" aria-hidden="true">
                    {entry.kind === 'dir' ? (isOpen ? '▾' : '▸') : ''}
                  </span>
                  <span className="files-icon" aria-hidden="true">
                    {entry.kind === 'dir' ? <FoldersIcon size={13} /> : <PageIcon size={13} />}
                  </span>
                  <span className="files-name">{entry.name}</span>
                  {entry.symlink && <span className="faint files-meta">link</span>}
                  {entry.kind === 'file' && entry.size !== null && (
                    <span className="faint files-meta num">{formatBytes(entry.size)}</span>
                  )}
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
  const doc = useMemo(() => {
    const dir = parentOf(path);
    const rawBase = `${location.origin}/api/projects/${projectId}/raw?path=`;
    const css = getComputedStyle(document.documentElement);
    const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${location.origin} https: data:; style-src 'unsafe-inline' ${location.origin}; font-src ${location.origin} data:"><base target="_blank">`;
    if (!markdown) return withBase(source, head, rawBase, dir);
    const body = marked.parse(source, { async: false, gfm: true }) as string;
    const style = `<style>
      body{font:14px/1.6 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:16px 20px;color:${color('--text', '#222')};background:${color('--surface', '#fff')}}
      a{color:${color('--accent', '#3b5bdb')}} img{max-width:100%}
      pre,code{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;background:${color('--surface-2', '#f4f4f4')};border-radius:4px}
      pre{padding:10px;overflow:auto} code{padding:1px 4px} pre code{padding:0}
      table{border-collapse:collapse} th,td{border:1px solid ${color('--border', '#ddd')};padding:4px 8px}
      blockquote{margin:0;padding-left:12px;border-left:3px solid ${color('--border', '#ddd')};color:${color('--text-2', '#555')}}
      h1,h2{border-bottom:1px solid ${color('--border', '#ddd')};padding-bottom:4px}
    </style>`;
    return `<!doctype html><html><head>${head}${style}</head><body>${rewriteRelative(body, rawBase, dir)}</body></html>`;
  }, [projectId, path, source, markdown]);
  return (
    <iframe
      className="files-frame"
      title={`Preview of ${path}`}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
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
function rewriteRelative(html: string, rawBase: string, dir: string): string {
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
  return withSrcset.replace(
    /\b(src|href)="(?![a-z][a-z0-9+.-]*:|#|\/\/|\/)([^"]+)"/gi,
    (match, attr: string, url: string) => {
      const isAsset = attr.toLowerCase() === 'src' || /\.css$/i.test(url.split(/[?#]/)[0]!);
      const target = isAsset ? joinPath(dir, url) : null;
      return target === null ? match : `${attr}="${rawBase}${encodeURIComponent(target)}"`;
    },
  );
}

/** An HTML file with the CSP and base injected into its head, and relative assets rewritten. */
function withBase(html: string, head: string, rawBase: string, dir: string): string {
  const rewritten = rewriteRelative(html, rawBase, dir);
  return /<head[^>]*>/i.test(rewritten)
    ? rewritten.replace(/<head[^>]*>/i, (m) => `${m}${head}`)
    : `<!doctype html><html><head>${head}</head><body>${rewritten}</body></html>`;
}
