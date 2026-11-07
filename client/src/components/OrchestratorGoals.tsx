import { Link } from 'react-router';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  GoalStatus,
  OrchestratorConfig,
  OrchestratorGoal,
  OrchestratorGoalView,
  GoalCard,
} from '../../../shared/orchestrator';
import type { CardStatus, CardWithProject } from '../../../shared/types';
import { api } from '../api';
import { Dropdown, type DropdownOption } from './Dropdown';
import { projectTagColors } from '../lib/projectColors';
import { formatRelative } from '../format';
import { serialPoll } from '../lib/serialPoll';
import { CheckIcon, CloseIcon, LinkIcon, PauseIcon, PlayIcon, RefreshIcon } from './icons';
import './orchestrator-chat.css';

// Goals (PM-433): objectives the orchestrator pursues until they are done. The chat records them
// when asked ("keep track of X and get it done"), or the owner adds one here; automatic checks
// keep bringing the chat back to an active goal until it is achieved or blocked.

const LABEL: Record<GoalStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  blocked: 'Blocked',
  achieved: 'Achieved',
  dropped: 'Dropped',
};
const TONE: Record<GoalStatus, string> = {
  active: 'badge badge-tracked',
  paused: 'badge',
  blocked: 'badge badge-attention',
  achieved: 'badge badge-done',
  dropped: 'badge',
};
/** The label of the button that makes a goal active again. */
const RESUME: Record<GoalStatus, string> = {
  active: 'Resume',
  paused: 'Resume',
  blocked: 'Resume',
  achieved: 'Reopen',
  dropped: 'Restore',
};
const POLL_MS = 15_000;
const SHOWN_CLOSED = 3;

const EMPTY_DRAFT = {
  title: '',
  objective: '',
  doneWhen: '',
  projectId: 0,
  cards: [] as number[],
};
const STATUS_LABEL: Record<CardStatus, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
};
/** Cards offered in a picker: open work first, newest first, then done ones. */
const PICKER_LIMIT = 300;

/** A card as a picker row (PM-449): key and title, with its column and project under it. */
function cardOption(c: CardWithProject): DropdownOption<number> {
  return {
    value: c.id,
    label: `${c.key}  ${c.title}`,
    sub: `${STATUS_LABEL[c.status]} · ${c.projectName || 'All projects'}`,
    icon: <span className="orchestrator-goal-card-dot" data-status={c.status} aria-hidden="true" />,
    title: `${c.key}: ${c.title}`,
  };
}

export function OrchestratorGoals({
  instance,
  projects = [],
  allProjectIds = [],
}: {
  instance: OrchestratorConfig;
  /** The orchestrator's projects, to tag a new goal with one (PM-448). */
  projects?: readonly { id: number; name: string }[];
  /** Every project id, so tags take the same colour as on the Board (PM-449). */
  allProjectIds?: readonly number[];
}) {
  const [goals, setGoals] = useState<OrchestratorGoalView[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  /** Every card, for the link pickers and the project colours; read with the goals. */
  const [allCards, setAllCards] = useState<CardWithProject[]>([]);
  const watchOnly = instance.strategy === 'observe';

  const load = async () => {
    const [next, cards] = await Promise.all([
      api.orchestratorGoals(instance.id),
      api.listAllCards().catch(() => null),
    ]);
    setGoals(next);
    if (cards) setAllCards(cards);
  };
  const colorOf = useMemo(
    () => projectTagColors([...allProjectIds, ...allCards.map((c) => c.projectId)]),
    [allProjectIds, allCards],
  );
  /** Cards in this orchestrator's projects, open ones first. */
  const scopedCards = useMemo(() => {
    const inScope = (c: CardWithProject) =>
      instance.projectIds?.length ? instance.projectIds.includes(c.projectId) : true;
    return allCards
      .filter(inScope)
      .sort(
        (a, b) =>
          Number(a.status === 'done') - Number(b.status === 'done') ||
          b.updatedAt.localeCompare(a.updatedAt),
      );
  }, [allCards, instance.projectIds]);
  useEffect(
    () => serialPoll(load, POLL_MS, { pauseWhenHidden: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instance.id],
  );
  // Start, Pause or a settings change alters every goal's follow-up: read them again at once
  // instead of waiting for the next poll (PM-454).
  const firstRender = useRef(true);
  useEffect(
    () => {
      if (firstRender.current) {
        firstRender.current = false;
        return;
      }
      void load().catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instance.enabled, instance.autoCheck, instance.strategy],
  );

  async function act(run: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await run();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  function add(e: FormEvent) {
    e.preventDefault();
    void act(async () => {
      await api.addOrchestratorGoal(instance.id, {
        title: draft.title,
        objective: draft.objective,
        doneWhen: draft.doneWhen,
        ...(draft.projectId ? { projectIds: [draft.projectId] } : {}),
        ...(draft.cards.length ? { cards: draft.cards.map(String) } : {}),
      });
      setDraft(EMPTY_DRAFT);
      setAdding(false);
    });
  }

  /** A goal being closed while some linked cards are open: the confirm dialog (PM-454). */
  const [closing, setClosing] = useState<OrchestratorGoalView | null>(null);
  const close = (goal: OrchestratorGoal, acceptReview: boolean) =>
    void act(async () => {
      await api.updateOrchestratorGoal(instance.id, goal.id, {
        status: 'achieved',
        force: true,
        ...(acceptReview ? { acceptReview: true } : {}),
      });
      setClosing(null);
    });
  const set = (goal: OrchestratorGoal, status: GoalStatus) =>
    void act(() => api.updateOrchestratorGoal(instance.id, goal.id, { status }));
  const link = (goal: OrchestratorGoal, cardId: number) =>
    void act(() =>
      api.updateOrchestratorGoal(instance.id, goal.id, { linkCards: [String(cardId)] }),
    );
  /** Picker rows for a goal: in-scope cards it does not link yet. */
  const linkOptions = (goal: OrchestratorGoalView): DropdownOption<number>[] => {
    const linked = new Set((goal.cards ?? []).map((c) => c.id));
    return [
      {
        value: 0,
        label: 'Link a card',
        icon: <LinkIcon size={12} />,
        disabled: true,
        title: 'Search by key or title, then pick a card to link',
      },
      ...scopedCards
        .filter((c) => !linked.has(c.id))
        .slice(0, PICKER_LIMIT)
        .map(cardOption),
    ];
  };
  const projectTag = (id: number, name: string) => (
    <span key={id} className="project-tag" style={{ ['--tag' as string]: colorOf.get(id) }}>
      {name}
    </span>
  );
  const unlink = (goal: OrchestratorGoal, key: string) =>
    void act(() => api.updateOrchestratorGoal(instance.id, goal.id, { unlinkCards: [key] }));

  const open = (goals ?? []).filter(
    (g) => g.status === 'active' || g.status === 'blocked' || g.status === 'paused',
  );
  const closed = (goals ?? []).filter((g) => !open.includes(g)).slice(0, SHOWN_CLOSED);

  return (
    <section className="orchestrator-goals" aria-label={`${instance.name} goals`}>
      <div className="orchestrator-goals-head">
        <div>
          <span className="orchestrator-subheading">Goals</span>
          {watchOnly ? (
            <p className="faint">Watch only orchestrators do not pursue goals.</p>
          ) : (
            <GoalsFollowUp goals={open} />
          )}
        </div>
        {!watchOnly && (
          <button
            type="button"
            className="btn btn-sm"
            aria-expanded={adding}
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? 'Cancel' : 'Add goal'}
          </button>
        )}
      </div>
      {error && <p className="error-banner">{error}</p>}
      {adding && (
        <form className="orchestrator-goal-form" onSubmit={add}>
          <label>
            Goal
            <input
              className="input"
              required
              maxLength={120}
              placeholder="Ship the login flow"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label>
            Objective
            <textarea
              className="input"
              required
              maxLength={4000}
              rows={3}
              placeholder="What to achieve, in which projects, and any constraints"
              value={draft.objective}
              onChange={(e) => setDraft({ ...draft, objective: e.target.value })}
            />
          </label>
          <label>
            Done when
            <input
              className="input"
              required
              maxLength={2000}
              placeholder="A condition anyone can check, such as: the e2e login test passes on main"
              value={draft.doneWhen}
              onChange={(e) => setDraft({ ...draft, doneWhen: e.target.value })}
            />
          </label>
          <div className="orchestrator-goal-form-row">
            {projects.length > 1 && (
              <div className="field">
                <span>Project</span>
                <Dropdown
                  label="Project"
                  value={draft.projectId}
                  options={[
                    { value: 0, label: 'All of its projects' },
                    ...projects.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                  onChange={(projectId) => setDraft({ ...draft, projectId })}
                />
              </div>
            )}
            <div className="field">
              <span>Cards (optional)</span>
              <Dropdown
                label="Cards"
                value={0}
                searchable
                searchPlaceholder="Search cards by key or title…"
                options={[
                  { value: 0, label: 'No cards' },
                  ...scopedCards
                    .filter((c) => !draft.projectId || c.projectId === draft.projectId)
                    .slice(0, PICKER_LIMIT)
                    .map(cardOption),
                ]}
                onChange={() => undefined}
                multiple={{
                  values: draft.cards,
                  allValue: 0,
                  onChange: (cards) => setDraft({ ...draft, cards }),
                }}
              />
            </div>
          </div>
          <div>
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
              Start goal
            </button>
          </div>
        </form>
      )}
      {goals && open.length === 0 && closed.length === 0 && !adding && (
        <p className="faint orchestrator-goals-empty">No goals yet.</p>
      )}
      {[...open, ...closed].length > 0 && (
        <ul className="orchestrator-goal-list">
          {[...open, ...closed].map((goal) => {
            const last = goal.progress.at(-1);
            return (
              <li key={goal.id} className="orchestrator-goal" data-status={goal.status}>
                <div className="orchestrator-goal-head">
                  <div className="orchestrator-goal-title">
                    <strong>{goal.title}</strong>
                    <span className={TONE[goal.status]}>{LABEL[goal.status]}</span>
                    {(goal.projects ?? []).length ? (
                      goal.projects.map((p) => projectTag(p.id, p.name))
                    ) : projects.length === 1 ? (
                      // No projects named: all of the orchestrator's, here just one.
                      projectTag(projects[0]!.id, projects[0]!.name)
                    ) : (
                      <span className="orchestrator-goal-project">All projects</span>
                    )}
                    <CardsDone goal={goal} />
                    {goal.followUp?.readyToClose && (
                      <span className="badge badge-done" title={goal.followUp.note}>
                        Ready to close
                      </span>
                    )}
                  </div>
                  {!watchOnly && (
                    <div
                      className="orchestrator-goal-actions"
                      role="group"
                      aria-label="Goal actions"
                    >
                      {goal.status === 'active' ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          title="Stop working on it for now; automatic checks skip it until you resume"
                          onClick={() => set(goal, 'paused')}
                        >
                          <PauseIcon size={12} /> Pause
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          title="Make it active again, so the orchestrator works on it until it is done"
                          onClick={() => set(goal, 'active')}
                        >
                          {goal.status === 'achieved' || goal.status === 'dropped' ? (
                            <RefreshIcon size={12} />
                          ) : (
                            <PlayIcon size={12} />
                          )}
                          {RESUME[goal.status]}
                        </button>
                      )}
                      {open.includes(goal) && (
                        <>
                          <div className="orchestrator-goal-linker">
                            <Dropdown
                              label={`Link a card to ${goal.title}`}
                              value={0}
                              searchable
                              searchPlaceholder="Search cards by key or title…"
                              disabled={busy}
                              options={linkOptions(goal)}
                              onChange={(cardId) => cardId && link(goal, cardId)}
                            />
                          </div>
                          <button
                            type="button"
                            className="btn btn-sm orchestrator-goal-achieve"
                            disabled={busy}
                            title="Close it as done"
                            onClick={() =>
                              (goal.cards ?? []).some((c) => c.status !== 'done')
                                ? setClosing(goal)
                                : set(goal, 'achieved')
                            }
                          >
                            <CheckIcon size={12} /> Mark achieved
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            disabled={busy}
                            title="Give it up; you can restore it later"
                            onClick={() => set(goal, 'dropped')}
                          >
                            <CloseIcon size={12} /> Drop
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <ClampedText>
                  <p className="orchestrator-goal-done">
                    <span className="faint">Done when:</span> {goal.doneWhen}
                  </p>
                  {last && (
                    <p className="orchestrator-goal-progress">
                      {last.note}{' '}
                      <span className="faint">
                        · {last.by === 'system' ? 'automatic' : last.by} · {formatRelative(last.at)}
                      </span>
                    </p>
                  )}
                </ClampedText>
                <GoalCards
                  goal={goal}
                  canEdit={!watchOnly}
                  busy={busy}
                  onUnlink={(key) => unlink(goal, key)}
                />
              </li>
            );
          })}
        </ul>
      )}
      {closing && (
        <CloseGoalDialog
          goal={closing}
          busy={busy}
          onCancel={() => setClosing(null)}
          onConfirm={(acceptReview) => close(closing, acceptReview)}
        />
      )}
    </section>
  );
}

/**
 * A goal's condition and latest note, cut to about four lines. "Show more" appears right under
 * the text only when something is actually cut off, measured on the rendered text.
 */
function ClampedText({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const check = () => setCut(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children, open]);
  return (
    <>
      <div ref={ref} className={open ? 'orchestrator-goal-text' : 'orchestrator-goal-text clamped'}>
        {children}
      </div>
      {(cut || open) && (
        <button
          type="button"
          className="orchestrator-goal-more"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}

/**
 * The cards that deliver a goal (PM-448), like an epic's tracked issues: a bar of how many are
 * done, then one chip per card (its status as a coloured dot) that opens it on the board.
 */
function GoalCards({
  goal,
  canEdit,
  busy,
  onUnlink,
}: {
  goal: OrchestratorGoalView;
  canEdit: boolean;
  busy: boolean;
  onUnlink: (key: string) => void;
}) {
  const cards = goal.cards ?? [];
  if (!cards.length) return null;
  return (
    <div className="orchestrator-goal-cards">
      <ul className="orchestrator-goal-card-list">
        {cards.map((c) => (
          <li key={c.id} className="orchestrator-goal-card" data-status={c.status}>
            <Link
              to={`/board?project=${c.projectId}&card=${c.id}`}
              title={`${c.key}: ${c.title} (${c.status.replace('_', ' ')})${c.worker ? ` · ${workerLabel(c.worker)}` : ''}`}
            >
              <span className="orchestrator-goal-card-dot" aria-hidden="true" />
              {c.key}
              {c.worker && (
                <span className="orchestrator-goal-card-worker" data-state={c.worker.state}>
                  {c.worker.name}
                </span>
              )}
            </Link>
            {canEdit && (
              <button
                type="button"
                className="orchestrator-goal-card-unlink"
                disabled={busy}
                aria-label={`Unlink ${c.key}`}
                title={`Unlink ${c.key} from this goal`}
                onClick={() => onUnlink(c.key)}
              >
                <CloseIcon size={10} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Session 138 Splash is working" etc., for a card's live worker (PM-454). */
function workerLabel(w: NonNullable<GoalCard['worker']>): string {
  const what = w.kind === 'session' ? `Session ${w.id} "${w.name}"` : `Run #${w.id} "${w.name}"`;
  const state =
    w.state === 'input'
      ? 'is asking you something'
      : w.state === 'idle'
        ? 'is idle, waiting for its next instruction'
        : w.state === 'queued'
          ? 'is queued'
          : 'is working on it';
  return `${what} ${state}`;
}

/** Linked cards done, as "1/3" with a small bar, in the goal's header (PM-448, PM-454). */
function CardsDone({ goal }: { goal: OrchestratorGoalView }) {
  const cards = goal.cards ?? [];
  if (!cards.length) return null;
  const done = cards.filter((c) => c.status === 'done').length;
  return (
    <span
      className="orchestrator-goal-done-count"
      title={`${done} of ${cards.length} linked cards done`}
    >
      <span className="num">
        {done}/{cards.length}
      </span>
      <span
        className="orchestrator-goal-bar"
        role="progressbar"
        aria-label={`${goal.title}: cards done`}
        aria-valuemin={0}
        aria-valuemax={cards.length}
        aria-valuenow={done}
      >
        <span style={{ width: `${Math.round((done / cards.length) * 100)}%` }} />
      </span>
    </span>
  );
}

/** "2:41" until a time, "due now" once it has passed (PM-454). */
function countdown(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((at - now) / 1000));
  if (seconds === 0) return 'due now';
  const m = Math.floor(seconds / 60);
  return m >= 60
    ? `in ${Math.floor(m / 60)} h ${m % 60} min`
    : `in ${m}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * One follow-up line for the orchestrator (PM-454). Its automatic check works on every active
 * goal at once, so the timing belongs to the panel, not to each goal: a live countdown to the next
 * check, when the last one ran, and how many goals it covers; or why no check will come.
 */
function GoalsFollowUp({ goals }: { goals: readonly OrchestratorGoalView[] }) {
  const active = goals.filter((g) => g.status === 'active' && g.followUp);
  const nexts = active
    .map((g) => g.followUp.nextCheckAt)
    .filter((at): at is string => Boolean(at))
    .map((at) => Date.parse(at));
  const lasts = active
    .map((g) => g.followUp.lastCheckAt)
    .filter((at): at is string => Boolean(at))
    .map((at) => Date.parse(at));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!nexts.length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [nexts.length]);
  if (!active.length)
    return (
      <p className="faint orchestrator-goals-followup">
        Ask the chat to keep at an objective until it is done, or add one here.
      </p>
    );
  const last = lasts.length ? `last ${minutesAgo(Math.max(...lasts), now)}` : 'not checked yet';
  const covers = `${active.length} active goal${active.length === 1 ? '' : 's'}`;
  if (!nexts.length)
    return (
      <p className="orchestrator-goals-followup orchestrator-goal-followup-warn">
        {active[0]!.followUp.note}{' '}
        <span className="faint">
          ({covers}, {last})
        </span>
      </p>
    );
  const next = Math.min(...nexts);
  return (
    <p className="orchestrator-goals-followup faint" role="timer" aria-live="off">
      Next check <strong className="num">{countdown(next, now)}</strong>
      {next <= now ? ' (it waits until the chat is idle)' : ''} · {last} · works on {covers}{' '}
      together
    </p>
  );
}

function minutesAgo(at: number, now: number): string {
  const m = Math.round((now - at) / 60_000);
  return m < 1 ? 'just now' : m >= 120 ? `${Math.round(m / 60)} h ago` : `${m} min ago`;
}

/**
 * Closing a goal while linked cards are still open (PM-454): lists them, and offers to accept the
 * ones in Review as Done on the way (their notes and finished runs record the owner's acceptance).
 */
function CloseGoalDialog({
  goal,
  busy,
  onCancel,
  onConfirm,
}: {
  goal: OrchestratorGoalView;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (acceptReview: boolean) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const openCards = (goal.cards ?? []).filter((c) => c.status !== 'done');
  const inReview = openCards.filter((c) => c.status === 'review');
  const [acceptReview, setAcceptReview] = useState(inReview.length > 0);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal?.();
  }, []);
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby="close-goal-title"
      onClose={onCancel}
    >
      <div className="dialog-body">
        <h2 id="close-goal-title">Mark "{goal.title}" achieved?</h2>
        <p>
          {openCards.length} linked card{openCards.length === 1 ? ' is' : 's are'} not Done yet:
        </p>
        <ul className="close-goal-cards">
          {openCards.map((c) => (
            <li key={c.id}>
              <span
                className="orchestrator-goal-card-dot"
                data-status={c.status}
                aria-hidden="true"
              />
              <strong>{c.key}</strong> {c.title}{' '}
              <span className="faint">({STATUS_LABEL[c.status]})</span>
            </li>
          ))}
        </ul>
        {inReview.length > 0 && (
          <label className="close-goal-accept">
            <input
              type="checkbox"
              checked={acceptReview}
              onChange={(e) => setAcceptReview(e.target.checked)}
            />
            Accept the {inReview.length} card{inReview.length === 1 ? '' : 's'} in Review as Done
          </label>
        )}
        <p className="faint">
          Other open cards stay where they are; unlink them if they no longer belong to this goal.
        </p>
      </div>
      <div className="dialog-footer">
        <button type="button" className="btn btn-sm" onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy}
          onClick={() => onConfirm(acceptReview)}
        >
          Mark achieved
        </button>
      </div>
    </dialog>
  );
}
