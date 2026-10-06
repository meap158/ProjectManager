import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from 'react';
import { ProviderIcon } from './icons';
import { Link, useNavigate } from 'react-router';
import {
  AGENT_AUTONOMY,
  AGENT_AUTONOMY_LABELS,
  CARD_STATUSES,
  CARD_STATUS_LABELS,
  type AgentAutonomy,
  type AgentPermissions,
  type AgentProviderStatus,
  type AgentSession,
  type AgentRun,
  type Card,
  type CardStatus,
  type ProjectSummary,
} from '../../../shared/types';
import { api } from '../api';
import { formatDate } from '../format';
import { CardAgentAudit } from './CardAgentAudit';
import { CardImages } from './CardImages';
import { Dropdown } from './Dropdown';
import { RunCard } from './RunCard';
import { ConfirmDelete } from './ConfirmDelete';

// Three ways to hand a card to an agent: one choice + one button, each explained in place.
type HandMode = 'terminal' | 'run' | 'send';
const HAND_MODE_KEY = 'pm.card.handMode';
function readHandMode(): HandMode {
  try {
    const v = localStorage.getItem(HAND_MODE_KEY);
    return v === 'run' || v === 'send' ? v : 'terminal';
  } catch {
    return 'terminal';
  }
}
const HAND_MODES: {
  value: HandMode;
  label: string;
  hint: string;
  action: string;
  title: string;
}[] = [
  {
    value: 'terminal',
    label: 'Interactive terminal',
    hint: 'Opens a session on this card in the Agents workspace. You can follow along and reply.',
    action: 'Open terminal',
    title: 'Start an interactive session on this card and open it in the Agents workspace',
  },
  {
    value: 'run',
    label: 'One-shot run',
    hint: 'Runs the task once in the background. You review and accept its changes afterwards.',
    action: 'Start run',
    title:
      'Move the card to In progress and run the task once in the background; accept or reject the result when it finishes',
  },
  {
    value: 'send',
    label: 'Send to a running session',
    hint: 'Submits the task automatically to a running session, so it keeps its context.',
    action: 'Send to session',
    title: 'Submit this card\u2019s task to the chosen running session',
  },
];

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
  creating = false,
  projects,
}: {
  creating?: boolean;
  projects?: ProjectSummary[];
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
  const [chosenProject, setChosenProject] = useState(projectId);
  const effectiveProjectId = creating ? chosenProject : projectId;
  const createdRef = useRef<Card | null>(null);
  const [hasCreated, setHasCreated] = useState(false);
  const [imagesBusy, setImagesBusy] = useState(false);
  const pendingImages = useRef<{ name: string; type: string; data: string }[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<CardStatus>('backlog');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState<AgentProviderStatus[] | null>(null);
  /** Running AI CLI sessions in this project, for "send to a running session". */
  const [loadedSessions, setLiveSessions] = useState<AgentSession[]>([]);
  const [sessionsProject, setSessionsProject] = useState<number | null>(null);
  const liveSessions = sessionsProject === effectiveProjectId ? loadedSessions : [];
  const [attachTo, setAttachTo] = useState<number | null>(null);
  const [dispatchProvider, setDispatchProvider] = useState('claude');
  const [prompt, setPrompt] = useState('');
  // A run's permission level: the user's pick, else the configured level for the chosen agent
  // (Settings → Agent permissions), else Edit files.
  const [chosenAutonomy, setAutonomy] = useState<AgentAutonomy | null>(null);
  const [permissions, setPermissions] = useState<AgentPermissions | null>(null);
  const configured = permissions
    ? (() => {
        const own = permissions.providers[dispatchProvider];
        const level = own && own !== 'inherit' ? own : permissions.global;
        return level === 'cli' ? null : level;
      })()
    : null;
  const autonomy: AgentAutonomy = chosenAutonomy ?? configured ?? 'edit';
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  // Pasting a screenshot anywhere in the dialog attaches it (text pastes are left alone).
  const pasteImages = useRef<((event: ClipboardEvent) => void) | null>(null);
  const [handMode, setHandModeState] = useState<HandMode>(readHandMode);
  const setHandMode = (next: HandMode) => {
    setHandModeState(next);
    try {
      localStorage.setItem(HAND_MODE_KEY, next);
    } catch {
      // Remembering the choice is a convenience only.
    }
  };
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [now, setNow] = useState(0);
  const [shownCard, setShownCard] = useState<Card | null>(null);

  // Reset the form during render when a different card opens (React's "adjusting state when a
  // prop changes" pattern), rather than in an effect.
  if (card !== shownCard) {
    setShownCard(card);
    if (creating) {
      setChosenProject(projectId);
      setHasCreated(false);
    }
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
    if (creating) {
      createdRef.current = null;
      pendingImages.current = [];
    }
  }, [card, creating]);

  useEffect(() => {
    let active = true;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (card) {
      if (!dialog.open) dialog.showModal();
      api.getPermissions().then(
        (next) => {
          if (active) setPermissions(next);
        },
        () => undefined,
      );
      api.listProviders().then(
        (next) => {
          if (active) setProviders(next);
        },
        () => {
          if (active) setProviders([]);
        },
      );
      if (effectiveProjectId)
        api.listSessions(effectiveProjectId).then(
          (all) => {
            if (!active) return;
            setSessionsProject(effectiveProjectId);
            const usable = all.filter(
              (s) =>
                s.status === 'running' && s.providerId !== 'shell' && s.providerId !== 'custom',
            );
            setLiveSessions(usable);
            setAttachTo(usable.at(-1)?.id ?? null);
          },
          () => setLiveSessions([]),
        );
      if (!creating)
        api.listRuns(effectiveProjectId, card.id).then(
          (next) => {
            if (!active) return;
            setRuns(next);
            setNow(Date.now());
          },
          () => setRuns([]),
        );
    } else if (dialog.open) {
      dialog.close();
    }
    return () => {
      active = false;
    };
  }, [card, effectiveProjectId, creating]);

  // One-shot dispatch needs a CLI with a prompt mode; Shell/Custom are for sessions.
  const aiProviders = (providers ?? []).filter((p) => p.binary !== null);
  const selectedProvider = aiProviders.find((p) => p.id === dispatchProvider);
  const autonomySupported =
    !selectedProvider?.autonomyArgs || selectedProvider.autonomyArgs[autonomy] !== undefined;

  const navigate = useNavigate();
  /** Interactive alternative to a one-shot run: a live session primed with the card task. */
  const mode: HandMode = handMode === 'send' && liveSessions.length === 0 ? 'terminal' : handMode;
  const modeInfo = HAND_MODES.find((m) => m.value === mode)!;

  async function ensureCard(): Promise<Card> {
    if (!card || !title.trim() || !effectiveProjectId)
      throw new Error('Enter a title and choose a project.');
    const existing = creating ? createdRef.current : card;
    const saved = existing
      ? await api.updateCard(existing.id, {
          title: title.trim(),
          description,
          ...(status !== existing.status ? { status } : {}),
        })
      : await api.addCard(effectiveProjectId, { title: title.trim(), description, status });
    if (creating) {
      createdRef.current = saved;
      setHasCreated(true);
      while (pendingImages.current.length) {
        await api.addAttachment(saved.id, pendingImages.current[0]!);
        pendingImages.current.shift();
      }
    }
    return saved;
  }

  async function openInTerminal() {
    if (!card) return;
    setDispatching(true);
    setDispatchError(null);
    try {
      const saved = await ensureCard();
      const session = await api.createSession(effectiveProjectId, {
        providerId: dispatchProvider,
        cardId: saved.id,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      });
      onDispatched?.();
      if (creating) onSaved(saved);
      navigate(`/workspace?open=${session.id}`);
    } catch (e) {
      setDispatchError((e as Error).message);
    } finally {
      setDispatching(false);
    }
  }

  /** Submit in the background to a session that already has context. */
  async function sendToSession() {
    const target = attachTo ?? liveSessions[0]?.id ?? null;
    if (!card || target === null) return;
    setDispatching(true);
    setDispatchError(null);
    try {
      const saved = await ensureCard();
      await api.attachCardToSession(target, saved.id, true, prompt.trim() || undefined);
      onDispatched?.();
      if (creating) onSaved(saved);
      onClose();
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
      const saved = await ensureCard();
      const run = await api.dispatchCard(effectiveProjectId, saved.id, {
        providerId: dispatchProvider,
        autonomy,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      });
      setRuns((prev) => [run, ...(prev ?? [])]);
      onDispatched?.();
      if (creating) onSaved(saved);
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
      onSaved(await ensureCard());
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
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-labelledby="card-dialog-title"
      onPaste={(event) => pasteImages.current?.(event)}
    >
      {card && (
        <form onSubmit={save}>
          <div className="dialog-body">
            <div className="page-header">
              <h2 id="card-dialog-title">
                {creating ? (
                  'New card'
                ) : (
                  <>
                    <span className="mono faint">{card.key}</span> Edit card
                  </>
                )}
              </h2>
              {!creating && (
                <span className="faint" style={{ fontSize: 12.5 }}>
                  Created {formatDate(card.createdAt)}
                  {card.closedAt && ` · Done ${formatDate(card.closedAt)}`}
                </span>
              )}
            </div>
            {creating && !projectId && (
              <div className="field">
                <label htmlFor="new-card-project">Project</label>
                <Dropdown
                  id="new-card-project"
                  label="Project"
                  value={chosenProject}
                  options={[
                    { value: 0, label: 'Choose a project...', disabled: true },
                    ...(projects ?? []).map((p) => ({ value: p.id, label: p.name })),
                  ]}
                  onChange={setChosenProject}
                  disabled={hasCreated || dispatching || saving}
                />
              </div>
            )}
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
              <Dropdown
                id="card-status"
                label="Column"
                value={status}
                options={CARD_STATUSES.map((s) => ({ value: s, label: CARD_STATUS_LABELS[s] }))}
                onChange={setStatus}
              />
            </div>
            <div className="field">
              <label htmlFor="card-description">Notes</label>
              <textarea
                id="card-description"
                aria-label="Description"
                className="textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What should this feature do? Acceptance criteria, links, ideas…"
              />
            </div>
            <div className="field">
              <label>Images</label>
              {/* Keyed by card: switching cards never shows the previous card's images. */}
              <CardImages
                key={card.id}
                cardId={card.id}
                pasteRef={pasteImages}
                onBusyChange={setImagesBusy}
                onPendingChange={
                  creating
                    ? (images) => {
                        pendingImages.current = images;
                      }
                    : undefined
                }
              />
            </div>
            {!creating && (
              <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
                Tip: mention <code>{card.key}</code> in a commit message to move this card to In
                progress, or write <code>Fixes {card.key}</code> to move it to Done on the next
                refresh.
              </p>
            )}
            {card.linkedCommit && (
              <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
                Last moved automatically by commit <code>{card.linkedCommit.slice(0, 10)}</code>.
              </p>
            )}
            <div className="field">
              <label id="hand-label">Hand to an agent</label>
              {liveSessionId !== null && (
                <p style={{ margin: 0 }}>
                  <Link to={`/workspace?open=${liveSessionId}`}>⌨ Open live terminal</Link>{' '}
                  <span className="faint" style={{ fontSize: 12.5 }}>
                    · a session is already working on this card
                  </span>
                </p>
              )}
              <div className="hand-modes" role="radiogroup" aria-labelledby="hand-label">
                {HAND_MODES.filter((m) => m.value !== 'send' || liveSessions.length > 0).map(
                  (m) => (
                    <label key={m.value} className="hand-mode" title={m.title}>
                      <input
                        type="radio"
                        name="hand-mode"
                        value={m.value}
                        checked={mode === m.value}
                        onChange={() => setHandMode(m.value)}
                      />
                      <span>
                        <b>{m.label}</b>
                        <span className="faint">{m.hint}</span>
                      </span>
                    </label>
                  ),
                )}
              </div>
              <div className="dispatch-row">
                {mode === 'send' ? (
                  <Dropdown
                    label="Running session"
                    value={attachTo ?? liveSessions[0]!.id}
                    options={liveSessions.map((x) => {
                      const cli = providers?.find((p) => p.id === x.providerId)?.name;
                      return {
                        value: x.id,
                        label: x.name,
                        // Which CLI it is, and the card it's on, as right-hand meta.
                        hint: [cli !== x.name ? cli : null, x.cardKey ? `on ${x.cardKey}` : null]
                          .filter(Boolean)
                          .join(' · '),
                      };
                    })}
                    onChange={setAttachTo}
                  />
                ) : (
                  <Dropdown
                    label="Agent"
                    value={dispatchProvider}
                    options={aiProviders.map((p) => ({
                      value: p.id,
                      label: p.name,
                      icon: <ProviderIcon id={p.id} size={14} />,
                      disabled: !p.available,
                      ...(p.available
                        ? {}
                        : { hint: 'unavailable', title: p.unavailableReason ?? 'Not available' }),
                    }))}
                    onChange={setDispatchProvider}
                  />
                )}
                {mode === 'run' && (
                  <Dropdown
                    label="What the agent may do"
                    value={autonomy}
                    options={AGENT_AUTONOMY.map((level) => {
                      const unsupported =
                        !!selectedProvider?.autonomyArgs &&
                        selectedProvider.autonomyArgs[level] === undefined;
                      return {
                        value: level,
                        label: AGENT_AUTONOMY_LABELS[level],
                        title: unsupported
                          ? 'This agent has no flag for this level'
                          : AUTONOMY_HINTS[level],
                        disabled: unsupported,
                        ...(unsupported ? { hint: 'not supported' } : {}),
                      };
                    })}
                    onChange={setAutonomy}
                  />
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  title={modeInfo.title}
                  disabled={
                    dispatching ||
                    saving ||
                    imagesBusy ||
                    !title.trim() ||
                    !effectiveProjectId ||
                    (mode === 'send'
                      ? liveSessions.length === 0
                      : !selectedProvider?.available || (mode === 'run' && !autonomySupported))
                  }
                  onClick={
                    mode === 'run' ? dispatch : mode === 'send' ? sendToSession : openInTerminal
                  }
                >
                  {dispatching ? 'Working…' : modeInfo.action}
                </button>
              </div>
              {mode !== 'send' && (
                <textarea
                  className="textarea"
                  style={{ minHeight: 70 }}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Leave empty to use the card title + notes as the task."
                  aria-label="Custom task for the agent (optional)"
                />
              )}
              {mode === 'run' && (
                <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
                  {AUTONOMY_HINTS[autonomy]}
                </p>
              )}
              {dispatchError && (
                <div className="error-banner" role="alert">
                  {dispatchError}
                </div>
              )}
            </div>
            {!creating && <CardAgentAudit key={card.id} cardId={card.id} />}
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
            {!creating && (
              <ConfirmDelete
                label="Delete card"
                text="Delete"
                heading={`Delete card ${card.key}?`}
                message="The card and its notes are removed from the board. This can't be undone."
                onConfirm={remove}
              />
            )}
            <div className="actions">
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={
                  saving || dispatching || imagesBusy || !title.trim() || !effectiveProjectId
                }
              >
                {creating ? 'Create card' : 'Save'}
              </button>
            </div>
          </div>
        </form>
      )}
    </dialog>
  );
}
