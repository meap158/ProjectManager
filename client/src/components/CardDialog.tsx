import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from 'react';
import { ProviderIcon } from './icons';
import { Link, useNavigate } from 'react-router';
import {
  CARD_STATUSES,
  CARD_STATUS_LABELS,
  type AgentProviderStatus,
  type AgentSession,
  type AgentRun,
  type Card,
  type CardStatus,
  type ProjectSummary,
} from '../../../shared/types';
import { api } from '../api';
import type { OrchestratorConfig } from '../../../shared/orchestrator';
import { formatDate, movedBy } from '../format';
import { CardAgentAudit } from './CardAgentAudit';
import { CardImages } from './CardImages';
import { Dropdown } from './Dropdown';
import { RunCard } from './RunCard';
import { ConfirmDelete } from './ConfirmDelete';

// Ways to hand a card to an agent: one choice + one button, each explained in place.
type HandMode = 'terminal' | 'run' | 'send' | 'orchestrator';
const HAND_MODE_KEY = 'pm.card.handMode';
function readHandMode(): HandMode {
  try {
    const v = localStorage.getItem(HAND_MODE_KEY);
    return v === 'run' || v === 'send' ? v : 'terminal';
  } catch {
    return 'terminal';
  }
}
/** The CLI last chosen for handing a card over (PM-8), kept like the hand mode. */
const PROVIDER_KEY = 'pm.card.provider';
function readProvider(): string {
  try {
    return localStorage.getItem(PROVIDER_KEY) || 'claude';
  } catch {
    return 'claude';
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
    label: 'Task session',
    hint: 'Opens a full interactive CLI for this task. It stops when the CLI exits; output stays until you delete it.',
    action: 'Open task session',
    title: 'Start an interactive session for this card without automatic crash restarts',
  },
  {
    value: 'send',
    label: 'Send to a running session',
    hint: 'Submits the task automatically to a running session, so it keeps its context.',
    action: 'Send to session',
    title: 'Submit this card\u2019s task to the chosen running session',
  },
  {
    value: 'orchestrator',
    label: 'Project orchestrator',
    hint: 'Queues the card in To do and asks the orchestrator that covers this project to pick it up.',
    action: 'Create & queue',
    title:
      'Create or move the card to To do and tick the orchestrator whose scope includes this project, so it plans a worker',
  },
];

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
  // The project a card is created on, or the one it lives on, is only the *default*: the Project
  // picker below can move it, so sessions, runs, dispatch and the save itself all follow the
  // chosen project rather than the prop the board passed in.
  const [chosenProject, setChosenProject] = useState(projectId);
  const effectiveProjectId = chosenProject;
  const createdRef = useRef<Card | null>(null);
  const [hasCreated, setHasCreated] = useState(false);
  const [imagesBusy, setImagesBusy] = useState(false);
  const pendingImages = useRef<{ name: string; type: string; data: string }[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [issueUrl, setIssueUrl] = useState('');
  const [status, setStatus] = useState<CardStatus>('backlog');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState<AgentProviderStatus[] | null>(null);
  /** Running AI CLI sessions in this project, for "send to a running session". */
  const [loadedSessions, setLiveSessions] = useState<AgentSession[]>([]);
  const [sessionsProject, setSessionsProject] = useState<number | null>(null);
  const liveSessions = sessionsProject === effectiveProjectId ? loadedSessions : [];
  const [attachTo, setAttachTo] = useState<number | null>(null);
  const [dispatchProvider, setDispatchProviderState] = useState(readProvider);
  const setDispatchProvider = (next: string) => {
    setDispatchProviderState(next);
    try {
      localStorage.setItem(PROVIDER_KEY, next);
    } catch {
      // Remembering the choice is a convenience only.
    }
  };
  const [prompt, setPrompt] = useState('');
  // Task sessions use the same permission policy as normal workspace sessions.
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
  // Which orchestrators this server has, fetched once (PM-142). The one covering this card's
  // project is derived below; the "Project orchestrator" hand mode is hidden when there is none.
  const [orchestrators, setOrchestrators] = useState<OrchestratorConfig[] | null>(null);
  /** Projects fetched by the dialog itself when the board did not pass a list (PM-154). */
  const [loadedProjects, setLoadedProjects] = useState<ProjectSummary[] | null>(null);

  // Reset the form during render when a different card opens (React's "adjusting state when a
  // prop changes" pattern), rather than in an effect.
  if (card !== shownCard) {
    setShownCard(card);
    // The card's own project wins over the board's: on the all-projects board every card carries
    // its project, and an edit must open on the project the card is actually in.
    setChosenProject(card ? card.projectId : projectId);
    if (creating) setHasCreated(false);
    if (card) {
      setTitle(card.title);
      setDescription(card.description);
      setIssueUrl(card.issueUrl ?? '');
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
      if (!creating && effectiveProjectId)
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

  // Which orchestrator covers this card's project, for the "Project orchestrator" hand mode
  // (PM-142). Fetched once; tolerant of an older server with no orchestrators API.
  useEffect(() => {
    if (typeof api.orchestrators !== 'function') return;
    let active = true;
    api.orchestrators().then(
      (state) => {
        if (active) setOrchestrators(state?.instances ?? []);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);
  const scopedOrchestrator = effectiveProjectId
    ? ((orchestrators ?? []).find(
        (i) => i.enabled !== false && (i.projectIds ?? []).includes(effectiveProjectId),
      ) ?? null)
    : null;

  // The Project picker needs the project list. Boards that know it (the all-projects board) pass
  // it in; a project board does not, so fetch it here. Tolerant of an older server without the
  // route: the picker then simply stays hidden.
  useEffect(() => {
    if (projects) return;
    if (typeof api.listProjects !== 'function') return;
    let active = true;
    api.listProjects().then(
      (all) => {
        if (active) setLoadedProjects(all);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [projects]);
  const projectChoices = projects ?? loadedProjects;

  // One-shot dispatch needs a CLI with a prompt mode; Shell/Custom are for sessions.
  const aiProviders = (providers ?? []).filter((p) => p.binary !== null);
  const selectedProvider = aiProviders.find((p) => p.id === dispatchProvider);

  const navigate = useNavigate();
  /** Interactive alternative to a one-shot run: a live session primed with the card task. */
  const mode: HandMode =
    handMode === 'send' && liveSessions.length === 0
      ? 'terminal'
      : handMode === 'orchestrator' && !scopedOrchestrator
        ? 'terminal'
        : handMode;
  const modeInfo = HAND_MODES.find((m) => m.value === mode)!;

  // The Project picker is shown whenever the dialog knows the projects, for a new card and for an
  // existing one: a card must be assignable (and re-assignable) from wherever it is opened. Only
  // the "All projects" entry (0) makes a card project-less (PM-138, PM-154).
  const showProjectPicker = !!projectChoices && projectChoices.length > 0;

  async function ensureCard(overrides?: { status?: CardStatus }): Promise<Card> {
    if (!card || !title.trim()) throw new Error('Enter a title.');
    const cardStatus = overrides?.status ?? status;
    const existing = creating ? createdRef.current : card;
    const saved = existing
      ? await api.updateCard(existing.id, {
          title: title.trim(),
          description,
          ...(issueUrl.trim() !== (existing.issueUrl ?? '')
            ? { issueUrl: issueUrl.trim() || null }
            : {}),
          ...(cardStatus !== existing.status ? { status: cardStatus } : {}),
          ...(chosenProject !== existing.projectId ? { projectId: chosenProject } : {}),
        })
      : await api.addCard(effectiveProjectId, {
          title: title.trim(),
          description,
          status: cardStatus,
          ...(issueUrl.trim() ? { issueUrl: issueUrl.trim() } : {}),
        });
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

  async function openInTerminal(supervise = true) {
    if (!card) return;
    setDispatching(true);
    setDispatchError(null);
    try {
      const saved = await ensureCard();
      const session = await api.createSession(effectiveProjectId, {
        providerId: dispatchProvider,
        cardId: saved.id,
        terminal: 'pty',
        // A task session is a normal interactive PTY, but does not restart after the CLI exits.
        // Keep its output/card link until the user deletes it so the result can be reviewed.
        supervise,
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

  /** Queue the card for the project's orchestrator: create it in To do, then tick it (PM-142). */
  async function sendToOrchestrator() {
    if (!card || !scopedOrchestrator) return;
    setDispatching(true);
    setDispatchError(null);
    try {
      const saved = await ensureCard({ status: 'todo' });
      await api.tickOrchestrators(scopedOrchestrator.id);
      onDispatched?.();
      onSaved(saved);
      onClose();
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
            {showProjectPicker && (
              <div className="field">
                <label htmlFor="new-card-project">Project</label>
                <Dropdown
                  id="new-card-project"
                  label="Project"
                  value={chosenProject}
                  options={[
                    {
                      value: 0,
                      label: 'All projects',
                      title:
                        'A card with no project. Assign a project before handing it to an agent.',
                    },
                    ...(projectChoices ?? []).map((p) => ({ value: p.id, label: p.name })),
                  ]}
                  onChange={setChosenProject}
                  disabled={hasCreated || dispatching || saving}
                />
                {!effectiveProjectId ? (
                  <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
                    This card belongs to no project yet. Pick one here before handing it to an
                    agent.
                  </p>
                ) : (
                  !creating && (
                    <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
                      Changing the project moves the card to that board.
                    </p>
                  )
                )}
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
              <label htmlFor="card-issue">GitHub issue</label>
              <input
                id="card-issue"
                className="input"
                type="url"
                value={issueUrl}
                onChange={(event) => setIssueUrl(event.target.value)}
                placeholder="https://github.com/owner/repo/issues/123"
              />
              <p className="faint">
                Link the issue once. Commits and pull requests referencing it can move this card
                through implementation and review.
              </p>
              {card.issueUrl && (
                <a href={card.issueUrl} target="_blank" rel="noreferrer">
                  Open linked issue
                </a>
              )}
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
                Last moved automatically by {movedBy(card.linkedCommit).kind}{' '}
                <code>{movedBy(card.linkedCommit).name}</code>.
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
                {HAND_MODES.filter(
                  (m) =>
                    (m.value !== 'send' || liveSessions.length > 0) &&
                    (m.value !== 'orchestrator' || scopedOrchestrator !== null),
                ).map((m) => (
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
                ))}
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
                ) : mode === 'orchestrator' ? null : (
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
                      : mode === 'orchestrator'
                        ? !scopedOrchestrator
                        : !selectedProvider?.available)
                  }
                  onClick={
                    mode === 'run'
                      ? () => openInTerminal(false)
                      : mode === 'send'
                        ? sendToSession
                        : mode === 'orchestrator'
                          ? sendToOrchestrator
                          : () => openInTerminal(true)
                  }
                >
                  {dispatching ? 'Working…' : modeInfo.action}
                </button>
              </div>
              {!effectiveProjectId && (
                <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
                  This card belongs to no project, so it can't be handed to an agent yet. Assign one
                  above first.
                </p>
              )}
              {mode === 'orchestrator' && scopedOrchestrator && (
                <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
                  “{scopedOrchestrator.name}” covers this project. Sending creates the card in To do
                  and asks that orchestrator to pick it up now.
                </p>
              )}
              {(mode === 'terminal' || mode === 'run') && (
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
                  Uses the agent permissions from Settings. You can type, paste images, resize, and
                  use the other terminal controls as usual. The finished session stays available for
                  review and can be removed from Agents.
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
                      onOpenSession={(id) => navigate(`/workspace?open=${id}`)}
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
                disabled={saving || dispatching || imagesBusy || !title.trim()}
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
