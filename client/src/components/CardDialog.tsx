import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  AGENT_AUTONOMY,
  AGENT_AUTONOMY_LABELS,
  CARD_STATUSES,
  CARD_STATUS_LABELS,
  type AgentAutonomy,
  type AgentProviderStatus,
  type AgentRun,
  type Card,
  type CardStatus,
} from '../../../shared/types';
import { api } from '../api';
import { formatDate } from '../format';
import { RunCard } from './RunCard';
import { DeleteButton } from './ui/delete-button';

const AUTONOMY_HINTS: Record<AgentAutonomy, string> = {
  read: 'Read-only: the agent can look around and answer, but not change files or run commands.',
  edit: 'Edit files: the agent can change files in this project; risky commands still need approval or are blocked.',
  full: 'Full access: no approvals. The agent can run any command as you. Use only on work you can revert.',
};

/** Edit a card's title, description and column. The column select is the keyboard alternative to drag-and-drop. */
export function CardDialog({
  card,
  projectId,
  onClose,
  onSaved,
  onDeleted,
  onDispatched,
  liveSessionId = null,
}: {
  card: Card | null;
  projectId: number;
  onClose: () => void;
  onSaved: (card: Card) => void;
  onDeleted: (id: number) => void;
  onDispatched?: () => void;
  /** Running interactive session linked to this card, if any. */
  liveSessionId?: number | null;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<CardStatus>('backlog');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState<AgentProviderStatus[] | null>(null);
  const [dispatchProvider, setDispatchProvider] = useState('claude');
  const [prompt, setPrompt] = useState('');
  const [autonomy, setAutonomy] = useState<AgentAutonomy>('edit');
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [now, setNow] = useState(0);
  const [shownCard, setShownCard] = useState<Card | null>(null);

  // Reset the form during render when a different card opens (React's "adjusting state when a
  // prop changes" pattern), rather than in an effect.
  if (card !== shownCard) {
    setShownCard(card);
    if (card) {
      setTitle(card.title);
      setDescription(card.description);
      setStatus(card.status);
      setError(null);
      setPrompt('');
      setDispatchError(null);
      setRuns(null);
    }
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (card) {
      if (!dialog.open) dialog.showModal();
      api.listProviders().then(setProviders, () => setProviders([]));
      api.listRuns(projectId, card.id).then(
        (next) => {
          setRuns(next);
          setNow(Date.now());
        },
        () => setRuns([]),
      );
    } else if (dialog.open) {
      dialog.close();
    }
  }, [card, projectId]);

  // One-shot dispatch needs a CLI with a prompt mode; Shell/Custom are for sessions.
  const aiProviders = (providers ?? []).filter((p) => p.binary !== null);
  const selectedProvider = aiProviders.find((p) => p.id === dispatchProvider);
  const autonomySupported =
    !selectedProvider?.autonomyArgs || selectedProvider.autonomyArgs[autonomy] !== undefined;

  const navigate = useNavigate();
  /** Interactive alternative to a one-shot run: a live session primed with the card task. */
  async function openInTerminal() {
    if (!card) return;
    setDispatching(true);
    setDispatchError(null);
    try {
      const session = await api.createSession(projectId, {
        providerId: dispatchProvider,
        cardId: card.id,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      });
      onDispatched?.();
      navigate(`/workspace?open=${session.id}`);
    } catch (e) {
      setDispatchError((e as Error).message);
    } finally {
      setDispatching(false);
    }
  }

  async function dispatch() {
    if (!card) return;
    setDispatching(true);
    setDispatchError(null);
    try {
      const run = await api.dispatchCard(projectId, card.id, {
        providerId: dispatchProvider,
        autonomy,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      });
      setRuns((prev) => [run, ...(prev ?? [])]);
      onDispatched?.();
    } catch (e) {
      setDispatchError((e as Error).message);
    } finally {
      setDispatching(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!card || !title.trim()) return;
    setSaving(true);
    try {
      const patch: Parameters<typeof api.updateCard>[1] = { title: title.trim(), description };
      // The server puts a card that changes column without a position at the top of it.
      if (status !== card.status) patch.status = status;
      onSaved(await api.updateCard(card.id, patch));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!card) return;
    try {
      await api.deleteCard(card.id);
      onDeleted(card.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} aria-labelledby="card-dialog-title">
      {card && (
        <form onSubmit={save}>
          <div className="dialog-body">
            <div className="page-header">
              <h2 id="card-dialog-title">
                <span className="mono faint">{card.key}</span> Edit card
              </h2>
              <span className="faint" style={{ fontSize: 12.5 }}>
                Created {formatDate(card.createdAt)}
                {card.closedAt && ` · Done ${formatDate(card.closedAt)}`}
              </span>
            </div>
            <div className="field">
              <label htmlFor="card-title">Title</label>
              <input
                id="card-title"
                className="input"
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="card-status">Column</label>
              <select
                id="card-status"
                className="select"
                value={status}
                onChange={(e) => setStatus(e.target.value as CardStatus)}
              >
                {CARD_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {CARD_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="card-description">Notes</label>
              <textarea
                id="card-description"
                className="textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What should this feature do? Acceptance criteria, links, ideas…"
              />
            </div>
            <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
              Tip: mention <code>{card.key}</code> in a commit message to move this card to In
              progress, or write <code>Fixes {card.key}</code> to move it to Done on the next
              refresh.
            </p>
            {card.linkedCommit && (
              <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
                Last moved automatically by commit <code>{card.linkedCommit.slice(0, 10)}</code>.
              </p>
            )}
            <div className="field">
              <label>Run with an agent</label>
              {liveSessionId !== null && (
                <p style={{ margin: 0 }}>
                  <Link to={`/workspace?open=${liveSessionId}`}>⌨ Open live terminal</Link>{' '}
                  <span className="faint" style={{ fontSize: 12.5 }}>
                    · a session is already working on this card
                  </span>
                </p>
              )}
              <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
                Dispatching moves the card to In progress and runs the prompt as a one-shot session.
                Validate the run to move the card on.
              </p>
              <div className="dispatch-row">
                <select
                  className="select"
                  aria-label="Agent provider"
                  value={dispatchProvider}
                  onChange={(e) => setDispatchProvider(e.target.value)}
                >
                  {aiProviders.map((p) => (
                    <option
                      key={p.id}
                      value={p.id}
                      disabled={!p.available}
                      title={p.unavailableReason}
                    >
                      {p.name}
                      {!p.available ? ' (unavailable)' : ''}
                    </option>
                  ))}
                </select>
                <select
                  className="select"
                  aria-label="What the agent may do"
                  value={autonomy}
                  onChange={(e) => setAutonomy(e.target.value as AgentAutonomy)}
                >
                  {AGENT_AUTONOMY.map((level) => (
                    <option
                      key={level}
                      value={level}
                      disabled={
                        !!selectedProvider?.autonomyArgs &&
                        selectedProvider.autonomyArgs[level] === undefined
                      }
                    >
                      {AGENT_AUTONOMY_LABELS[level]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={dispatching || !selectedProvider?.available || !autonomySupported}
                  onClick={dispatch}
                >
                  {dispatching ? 'Dispatching…' : 'Dispatch'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={dispatching || !selectedProvider?.available}
                  onClick={openInTerminal}
                  title="Start an interactive session on this card and open it in the Agents workspace"
                >
                  Work on it in a terminal
                </button>
              </div>
              <textarea
                className="textarea"
                style={{ minHeight: 70 }}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={`Leave empty to use the card title + notes as the prompt.`}
                aria-label="Custom run prompt (optional)"
              />
              <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
                {AUTONOMY_HINTS[autonomy]}
              </p>
              {dispatchError && (
                <div className="error-banner" role="alert">
                  {dispatchError}
                </div>
              )}
            </div>
            {runs !== null && runs.length > 0 && (
              <div className="field">
                <label>Agent runs ({runs.length})</label>
                <div className="runs">
                  {runs.map((r) => (
                    <RunCard
                      key={r.id}
                      run={r}
                      now={now}
                      onChanged={(next) =>
                        setRuns((prev) => {
                          if (!prev) return [next];
                          if (prev.some((x) => x.id === next.id)) {
                            return prev.map((x) => (x.id === next.id ? next : x));
                          }
                          return [next, ...prev];
                        })
                      }
                      onDeleted={(id) =>
                        setRuns((prev) => prev?.filter((x) => x.id !== id) ?? prev)
                      }
                    />
                  ))}
                </div>
              </div>
            )}
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
          </div>
          <div className="dialog-footer" style={{ alignItems: 'center' }}>
            <DeleteButton onConfirm={remove} aria-label="Delete card" />
            <div className="actions">
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving || !title.trim()}>
                Save
              </button>
            </div>
          </div>
        </form>
      )}
    </dialog>
  );
}
