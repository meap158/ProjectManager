import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CARD_STATUSES,
  CARD_STATUS_LABELS,
  type Card,
  type CardStatus,
  type ProjectSummary,
} from '../../../shared/types';
import { api } from '../api';
import { Dropdown } from './Dropdown';

/**
 * New card: title, column and notes (and the project, which is required, when adding from the
 * global board). Creating it hands the card back so the caller can open the full card dialog
 * (images, hand to an agent) straight away.
 */
export function NewCardDialog({
  open,
  status,
  projectId,
  projects,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** Column the card starts in (the column whose + was clicked). */
  status: CardStatus;
  /** Fixed project (a project's board); omit to make the project a required choice. */
  projectId?: number;
  /** Projects to choose from when projectId is omitted. */
  projects?: ProjectSummary[];
  onClose: () => void;
  onCreated: (card: Card) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [column, setColumn] = useState<CardStatus>(status);
  const [project, setProject] = useState<number>(projectId ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setTitle('');
      setDescription('');
      setColumn(status);
      setProject(projectId ?? 0);
      setError(null);
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, status, projectId]);

  const needsProject = projectId === undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !project) return;
    setBusy(true);
    setError(null);
    try {
      const card = await api.addCard(project, {
        title: title.trim(),
        description,
        status: column,
      });
      onCreated(card);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="new-card-title">
      <form onSubmit={submit}>
        <div className="dialog-body">
          <h2 id="new-card-title" style={{ margin: 0 }}>
            New card
          </h2>
          {needsProject && (
            <div className="field">
              <label htmlFor="new-card-project">Project</label>
              <Dropdown
                id="new-card-project"
                label="Project"
                value={project}
                options={[
                  { value: 0, label: 'Choose a project…', disabled: true, title: 'Required' },
                  ...(projects ?? []).map((p) => ({ value: p.id, label: p.name })),
                ]}
                onChange={setProject}
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="new-card-title-input">Title</label>
            <input
              id="new-card-title-input"
              className="input"
              value={title}
              autoFocus
              maxLength={200}
              required
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs doing?"
            />
          </div>
          <div className="field">
            <label htmlFor="new-card-column">Column</label>
            <Dropdown
              id="new-card-column"
              label="Column"
              value={column}
              options={CARD_STATUSES.map((s) => ({ value: s, label: CARD_STATUS_LABELS[s] }))}
              onChange={setColumn}
            />
          </div>
          <div className="field">
            <label htmlFor="new-card-notes">Notes</label>
            <textarea
              id="new-card-notes"
              className="textarea"
              style={{ minHeight: 100 }}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Acceptance criteria, links, ideas… (images can be added after creating)"
            />
          </div>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <span className="faint" style={{ fontSize: 12.5, alignSelf: 'center' }}>
            {needsProject && !project ? 'Pick a project to add the card to.' : ''}
          </span>
          <div className="actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !title.trim() || !project}
              title="Create the card, then open it to add images or hand it to an agent"
            >
              {busy ? 'Creating…' : 'Create card'}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
