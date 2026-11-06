import { Link } from 'react-router';
import {
  useEffect,
  useLayoutEffect,
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
} from '../../../shared/orchestrator';
import { api } from '../api';
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

/** Card keys typed as "PM-12, PM-15" or one per line. */
const cardKeys = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter(Boolean);

const EMPTY_DRAFT = { title: '', objective: '', doneWhen: '', projectId: 0, cards: '' };

export function OrchestratorGoals({
  instance,
  projects = [],
}: {
  instance: OrchestratorConfig;
  /** The orchestrator's projects, to tag a new goal with one (PM-448). */
  projects?: readonly { id: number; name: string }[];
}) {
  const [goals, setGoals] = useState<OrchestratorGoalView[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  /** The goal whose "Link cards" field is open, and what is typed in it. */
  const [linking, setLinking] = useState<{ goalId: number; text: string } | null>(null);
  const watchOnly = instance.strategy === 'observe';

  const load = async () => setGoals(await api.orchestratorGoals(instance.id));
  useEffect(
    () => serialPoll(load, POLL_MS, { pauseWhenHidden: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instance.id],
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
      const cards = cardKeys(draft.cards);
      await api.addOrchestratorGoal(instance.id, {
        title: draft.title,
        objective: draft.objective,
        doneWhen: draft.doneWhen,
        ...(draft.projectId ? { projectIds: [draft.projectId] } : {}),
        ...(cards.length ? { cards } : {}),
      });
      setDraft(EMPTY_DRAFT);
      setAdding(false);
    });
  }

  const set = (goal: OrchestratorGoal, status: GoalStatus) =>
    void act(() => api.updateOrchestratorGoal(instance.id, goal.id, { status }));
  const link = (e: FormEvent) => {
    e.preventDefault();
    if (!linking) return;
    const keys = cardKeys(linking.text);
    if (!keys.length) return;
    void act(async () => {
      await api.updateOrchestratorGoal(instance.id, linking.goalId, { linkCards: keys });
      setLinking(null);
    });
  };
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
          <p className="faint">
            {watchOnly
              ? 'Watch only orchestrators do not pursue goals.'
              : !instance.enabled
                ? 'This orchestrator is paused, so goals only move when you write in its chat. Press Start, with "Check on its own" on, to keep them going.'
                : instance.autoCheck
                  ? 'Ask the chat to keep at an objective until it is done, or add one here. Automatic checks keep it going.'
                  : 'Ask the chat to keep at an objective, or add one here. Turn on "Check on its own" so it keeps going without you.'}
          </p>
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
              <label>
                Project
                <select
                  className="input"
                  value={draft.projectId}
                  onChange={(e) => setDraft({ ...draft, projectId: Number(e.target.value) })}
                >
                  <option value={0}>All of its projects</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Cards (optional)
              <input
                className="input"
                placeholder="PM-12, PM-15"
                value={draft.cards}
                onChange={(e) => setDraft({ ...draft, cards: e.target.value })}
              />
            </label>
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
                <div className="orchestrator-goal-title">
                  <strong>{goal.title}</strong>
                  <span className={TONE[goal.status]}>{LABEL[goal.status]}</span>
                  {(goal.projects ?? []).length ? (
                    goal.projects.map((p) => (
                      <span key={p.id} className="orchestrator-goal-project">
                        {p.name}
                      </span>
                    ))
                  ) : (
                    // No projects named: all of the orchestrator's, which may be just one.
                    <span className="orchestrator-goal-project">
                      {projects.length === 1 ? projects[0]!.name : 'All projects'}
                    </span>
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
                {!watchOnly && (
                  <div className="orchestrator-goal-actions" role="group" aria-label="Goal actions">
                    {!watchOnly && goal.status === 'active' ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        title="Stop working on it for now; automatic checks skip it until you resume"
                        onClick={() => set(goal, 'paused')}
                      >
                        <PauseIcon size={12} /> Pause
                      </button>
                    ) : !watchOnly ? (
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
                    ) : null}
                    {!watchOnly && open.includes(goal) && (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={busy}
                          aria-expanded={linking?.goalId === goal.id}
                          title="Link the cards that deliver this goal"
                          onClick={() =>
                            setLinking((l) =>
                              l?.goalId === goal.id ? null : { goalId: goal.id, text: '' },
                            )
                          }
                        >
                          <LinkIcon size={12} /> Link cards
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm orchestrator-goal-achieve"
                          disabled={busy}
                          title="Close it as done"
                          onClick={() => set(goal, 'achieved')}
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
                {linking?.goalId === goal.id && (
                  <form className="orchestrator-goal-link" onSubmit={link}>
                    <input
                      className="input"
                      autoFocus
                      aria-label={`Cards to link to ${goal.title}`}
                      placeholder="PM-12, PM-15"
                      value={linking.text}
                      onChange={(e) => setLinking({ goalId: goal.id, text: e.target.value })}
                    />
                    <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
                      Link
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
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
  const done = cards.filter((c) => c.status === 'done').length;
  return (
    <div className="orchestrator-goal-cards">
      <div className="orchestrator-goal-cards-progress">
        <span className="faint num">
          {done} of {cards.length} cards done
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
      </div>
      <ul className="orchestrator-goal-card-list">
        {cards.map((c) => (
          <li key={c.id} className="orchestrator-goal-card" data-status={c.status}>
            <Link
              to={`/board?project=${c.projectId}&card=${c.id}`}
              title={`${c.key}: ${c.title} (${c.status.replace('_', ' ')})`}
            >
              <span className="orchestrator-goal-card-dot" aria-hidden="true" />
              {c.key}
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
