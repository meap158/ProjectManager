import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BulkAddResult, DirectoryListing, ProjectDetail } from '../../../shared/types';
import { api } from '../api';

/** Modal for tracking folders. Select one folder, or tick several to track them all at once. */
export function AddProjectDialog({
  open,
  onClose,
  onAdded,
  onAddedMany,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (project: ProjectDetail) => void;
  onAddedMany?: (result: BulkAddResult) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState('');
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setError(null);
      setBrowseError(null);
      setSelected([]);
      browse(undefined);
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  async function browse(target: string | undefined) {
    setBrowseError(null);
    try {
      const result = await api.browse(target);
      setListing(result);
      setPath(result.path);
    } catch (e) {
      setBrowseError((e as Error).message);
    }
  }

  function toggleSelected(folder: string, isTracked?: boolean) {
    if (isTracked) return;
    setSelected((prev) =>
      prev.some((p) => p.toLowerCase() === folder.toLowerCase())
        ? prev.filter((p) => p.toLowerCase() !== folder.toLowerCase())
        : [...prev, folder],
    );
  }

  function addCurrentToSelection() {
    const current = path.trim();
    if (!current) return;
    // The open folder is already tracked: nothing to queue.
    if (listing && current.toLowerCase() === listing.path.toLowerCase() && listing.trackedAs) {
      return;
    }
    setSelected((prev) =>
      prev.some((p) => p.toLowerCase() === current.toLowerCase()) ? prev : [...prev, current],
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (selected.length > 1) {
        const result = await api.addProjects(selected);
        if (result.added.length === 0) {
          setError(result.skipped[0]?.reason ?? 'Could not track any of the selected folders.');
          return;
        }
        if (onAddedMany) {
          onAddedMany(result);
        } else {
          // Fall back to single-callback usage: open the first project added.
          onAdded(result.added[0]! as ProjectDetail);
        }
        if (result.skipped.length > 0) {
          setError(
            `Skipped ${result.skipped.length}: ${result.skipped.map((s) => `${s.path} (${s.reason})`).join('; ')}`,
          );
        }
      } else {
        const single = selected.length === 1 ? selected[0]! : path.trim();
        if (!single) return;
        onAdded(await api.addProject(single));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const bulk = selected.length > 1;
  // The open folder itself is already tracked: single-track has nothing to do.
  const currentIsTracked =
    selected.length === 0 &&
    !!listing?.trackedAs &&
    path.trim().toLowerCase() === listing.path.toLowerCase();
  const primaryDisabled = saving || (selected.length === 0 && (!path.trim() || currentIsTracked));
  const primaryLabel = saving
    ? 'Tracking…'
    : selected.length > 1
      ? `Track ${selected.length} folders`
      : selected.length === 1
        ? 'Track 1 folder'
        : 'Track this folder';

  return (
    <dialog ref={dialogRef} onClose={onClose} aria-labelledby="add-project-title">
      <form onSubmit={submit}>
        <div className="dialog-body">
          <h2 id="add-project-title">Track project folders</h2>
          <p className="faint" style={{ margin: 0, fontSize: 13 }}>
            Tick several subfolders to track them all at once, or track the single folder below.
          </p>
          <div className="field">
            <label htmlFor="project-path">Folder path</label>
            <div className="path-row">
              <input
                id="project-path"
                className="input mono"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.altKey) {
                    e.preventDefault();
                    browse(path);
                  }
                }}
                placeholder="C:\Code\my-project or /home/me/code/my-project"
                spellCheck={false}
                autoComplete="off"
              />
              <button type="button" className="btn" onClick={() => browse(path)}>
                Go
              </button>
              <button
                type="button"
                className="btn"
                title={
                  listing?.trackedAs && path.trim().toLowerCase() === listing.path.toLowerCase()
                    ? `Already tracking this folder as "${listing.trackedAs}"`
                    : 'Add the folder above to the multi-track list'
                }
                onClick={addCurrentToSelection}
                disabled={
                  !path.trim() ||
                  (!!listing?.trackedAs && path.trim().toLowerCase() === listing.path.toLowerCase())
                }
              >
                ＋ List
              </button>
            </div>
          </div>

          {listing?.trackedAs && (
            <div className="notice" role="status">
              <span>
                Already tracking this folder as <b>{listing.trackedAs}</b>. Pick a subfolder below
                to track more.
              </span>
            </div>
          )}

          {selected.length > 0 && (
            <div className="field">
              <label>
                Folders to track ({selected.length})
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  style={{ marginLeft: 8 }}
                  onClick={() => setSelected([])}
                >
                  Clear
                </button>
              </label>
              <div className="selected-list" aria-label="Selected folders">
                {selected.map((s) => (
                  <span key={s} className="chip mono" title={s}>
                    <span className="truncate" style={{ maxWidth: 380 }}>
                      {s}
                    </span>
                    <button
                      type="button"
                      className="chip-x"
                      aria-label={`Remove ${s}`}
                      onClick={() => toggleSelected(s)}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {listing && (
            <div className="field">
              <div className="path-row" style={{ justifyContent: 'space-between' }}>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!listing.parent}
                    onClick={() => listing.parent && browse(listing.parent)}
                  >
                    ↑ Up
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => browse(listing.home)}>
                    Home
                  </button>
                  {listing.roots.length > 1 &&
                    listing.roots.map((root) => (
                      <button
                        type="button"
                        key={root}
                        className="btn btn-sm"
                        onClick={() => browse(root)}
                      >
                        {root.replace(/\\$/, '')}
                      </button>
                    ))}
                </div>
              </div>
              <div className="folder-list" role="list" aria-label="Subfolders">
                {listing.entries.length === 0 && (
                  <div className="faint" style={{ padding: '10px 12px' }}>
                    No subfolders here.
                  </div>
                )}
                {listing.entries.map((entry) => {
                  const checked = selected.some(
                    (p) => p.toLowerCase() === entry.path.toLowerCase(),
                  );
                  return (
                    <div
                      key={entry.path}
                      role="listitem"
                      className={`folder-row${checked ? ' is-selected' : ''}${entry.isTracked ? ' is-tracked' : ''}`}
                    >
                      <input
                        type="checkbox"
                        aria-label={
                          entry.isTracked
                            ? `${entry.path} is already tracked`
                            : `Track ${entry.path}`
                        }
                        checked={checked || entry.isTracked}
                        disabled={entry.isTracked}
                        onChange={() => toggleSelected(entry.path, entry.isTracked)}
                      />
                      <button
                        type="button"
                        className="folder-name"
                        onClick={() => browse(entry.path)}
                        title={entry.path}
                      >
                        <span aria-hidden="true">📁</span>
                        <span className="truncate">{entry.name}</span>
                        {entry.isTracked ? (
                          <span className="badge badge-tracked" title="Already tracked">
                            ✓ tracked
                          </span>
                        ) : (
                          entry.isGitRepo && <span className="badge">git</span>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="faint" style={{ fontSize: 12.5 }}>
                Tick boxes to queue folders{bulk ? '' : ' (or just press “Track this folder”)'};
                click a name to open it.
              </div>
            </div>
          )}
          {browseError && <div className="error-banner">{browseError}</div>}
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={primaryDisabled}>
            {saving && <span className="spinner" />}
            {primaryLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
