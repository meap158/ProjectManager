import { useEffect, useState, type FormEvent } from 'react';
import type {
  GoalStatus,
  OrchestratorConfig,
  OrchestratorGoal,
} from '../../../shared/orchestrator';
import { api } from '../api';
import { formatRelative } from '../format';
import { serialPoll } from '../lib/serialPoll';
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
const POLL_MS = 15_000;
const SHOWN_CLOSED = 3;

export function OrchestratorGoals({ instance }: { instance: OrchestratorConfig }) {
  const [goals, setGoals] = useState<OrchestratorGoal[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: '', objective: '', doneWhen: '' });
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
      await api.addOrchestratorGoal(instance.id, draft);
      setDraft({ title: '', objective: '', doneWhen: '' });
      setAdding(false);
    });
  }

  const set = (goal: OrchestratorGoal, status: GoalStatus) =>
    void act(() => api.updateOrchestratorGoal(instance.id, goal.id, { status }));

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
                </div>
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
                {!watchOnly && (open.includes(goal) || goal.status !== 'dropped') && (
                  <div className="orchestrator-goal-actions">
                    {goal.status === 'active' && (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={busy}
                        onClick={() => set(goal, 'paused')}
                      >
                        Pause
                      </button>
                    )}
                    {goal.status !== 'active' && (
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        disabled={busy}
                        onClick={() => set(goal, 'active')}
                      >
                        {goal.status === 'achieved' ? 'Reopen' : 'Resume'}
                      </button>
                    )}
                    {open.includes(goal) && (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={busy}
                          onClick={() => set(goal, 'achieved')}
                        >
                          Mark achieved
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={busy}
                          onClick={() => set(goal, 'dropped')}
                        >
                          Drop
                        </button>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
