import type { ReactNode } from 'react';
import type { AgentRun, AgentSession } from '../../../shared/types';
import { formatBytes, formatDate, formatDuration, formatNumber, formatRelative } from '../format';

// One list for everything agents do in a project (or across projects on the workspace):
// - Terminal: an interactive session. It keeps running (and relaunches after crashes) until you
//   stop it, and you type into it.
// - One-shot: a run dispatched from a card. It runs the prompt once, then waits for you to
//   accept or reject what it changed.
// Rows carry the facts that answer "what is this and how is it doing" at a glance.

export type WorkItem = { kind: 'session'; item: AgentSession } | { kind: 'run'; item: AgentRun };
export type WorkKey = `session:${number}` | `run:${number}`;

export const workKey = (w: WorkItem): WorkKey => `${w.kind}:${w.item.id}`;

const KIND = {
  session: {
    label: 'Terminal',
    title:
      'Interactive session: keeps running (and relaunches after crashes) until you stop it. Type into it here or in the workspace.',
  },
  run: {
    label: 'One-shot',
    title:
      'Run dispatched from a card: runs the prompt once, then waits for you to accept or reject what it changed.',
  },
} as const;

const isActive = (w: WorkItem) =>
  w.kind === 'session'
    ? w.item.status === 'running'
    : w.item.status === 'running' || w.item.status === 'queued';

const lastActivity = (w: WorkItem) =>
  Date.parse(
    w.kind === 'session'
      ? (w.item.endedAt ?? w.item.startedAt)
      : (w.item.endedAt ?? w.item.startedAt ?? w.item.createdAt),
  );

/** Running work first, then the most recently active. */
export function mergeWork(sessions: AgentSession[], runs: AgentRun[]): WorkItem[] {
  const all: WorkItem[] = [
    ...sessions.map((item) => ({ kind: 'session' as const, item })),
    ...runs.map((item) => ({ kind: 'run' as const, item })),
  ];
  return all.sort(
    (a, b) => Number(isActive(b)) - Number(isActive(a)) || lastActivity(b) - lastActivity(a),
  );
}

interface Fact {
  text: string;
  title?: string;
}

export function sessionFacts(s: AgentSession, now: number, tokens?: number | null): Fact[] {
  const facts: Fact[] = [];
  if (s.status === 'running') {
    facts.push({
      text: `up ${formatDuration(now - Date.parse(s.startedAt))}`,
      title: `Running since ${new Date(s.startedAt).toLocaleString()}`,
    });
  } else if (s.endedAt) {
    facts.push({
      text: `ran ${formatDuration(Date.parse(s.endedAt) - Date.parse(s.startedAt))}`,
      title: `Ended ${new Date(s.endedAt).toLocaleString()}`,
    });
  }
  facts.push({
    text: `started ${formatRelative(s.createdAt)}`,
    title: `First started ${formatDate(s.createdAt)}, ${new Date(s.createdAt).toLocaleTimeString()}`,
  });
  if (s.restarts > 0) {
    facts.push({
      text: `${s.restarts} restart${s.restarts === 1 ? '' : 's'}`,
      title: s.lastRestartAt
        ? `Relaunched after a crash or reboot; last ${new Date(s.lastRestartAt).toLocaleString()}`
        : 'Relaunched after a crash or reboot',
    });
  }
  if (s.queuedInputBytes > 0) {
    facts.push({
      text: `${formatBytes(s.queuedInputBytes)} input queued`,
      title: 'Typed while the session was down; sent when it starts again',
    });
  }
  if (tokens) {
    facts.push({
      text: `${formatNumber(tokens)} tokens`,
      title: 'Input + output tokens, read from the CLI’s own session transcript',
    });
  }
  return facts;
}

export function runFacts(r: AgentRun, now: number): Fact[] {
  const facts: Fact[] = [];
  const start = r.startedAt ? Date.parse(r.startedAt) : null;
  if (r.status === 'queued') facts.push({ text: 'queued' });
  else if (r.status === 'running' && start) {
    facts.push({ text: `running ${formatDuration(now - start)}` });
  } else if (start && r.endedAt) {
    facts.push({
      text: `took ${formatDuration(Date.parse(r.endedAt) - start)}`,
      title: `Ended ${new Date(r.endedAt).toLocaleString()}`,
    });
  }
  facts.push({
    text: formatRelative(r.startedAt ?? r.createdAt),
    title: `Dispatched ${new Date(r.createdAt).toLocaleString()}`,
  });
  if (r.changes && r.changes.files.length > 0) {
    const n = r.changes.files.length;
    facts.push({ text: `${n} file${n === 1 ? '' : 's'} changed` });
  }
  if (r.attempts > 1) facts.push({ text: `try ${r.attempts} of ${r.maxAttempts}` });
  return facts;
}

/** What the row says about state, in words (never colour alone). */
function stateLabel(w: WorkItem): { text: string; tone?: 'good' | 'bad' | 'attention' } {
  if (w.kind === 'session') {
    const s = w.item;
    if (s.status === 'running') return { text: 'running', tone: 'good' };
    if (s.status === 'dead') return { text: 'crashed', tone: 'bad' };
    return { text: s.status === 'killed' ? 'stopped' : 'ended' };
  }
  const r = w.item;
  if (r.validation === 'accepted') return { text: 'accepted', tone: 'good' };
  if (r.validation === 'rejected') return { text: 'rejected' };
  if (r.status === 'succeeded' || r.status === 'failed') {
    return { text: r.status === 'failed' ? 'failed · review' : 'needs review', tone: 'attention' };
  }
  return { text: r.status === 'killed' ? 'stopped' : r.status };
}

export function AgentWorkList({
  items,
  selected,
  onSelect,
  now,
  tokens,
  projectNames,
  actions,
}: {
  items: WorkItem[];
  selected: WorkKey | null;
  onSelect: (key: WorkKey) => void;
  now: number;
  /** Token totals by session id, where the CLI exposes them. */
  tokens?: Map<number, number | null>;
  /** Shown when the list spans several projects. */
  projectNames?: Map<number, string>;
  actions?: (w: WorkItem) => ReactNode;
}) {
  return (
    <ul className="list work-list">
      {items.map((w) => {
        const key = workKey(w);
        const state = stateLabel(w);
        const facts =
          w.kind === 'session'
            ? sessionFacts(w.item, now, tokens?.get(w.item.id))
            : runFacts(w.item, now);
        return (
          <li key={key} className={key === selected ? 'selected' : undefined}>
            <button
              type="button"
              className="work-row"
              aria-current={key === selected || undefined}
              onClick={() => onSelect(key)}
              title={
                w.kind === 'session'
                  ? `${w.item.command.join(' ')}\n${w.item.cwd}`
                  : w.item.prompt || w.item.command.join(' ')
              }
            >
              <span className="work-line">
                <span className={`status-dot tone-${state.tone ?? 'idle'}`} aria-hidden="true" />
                <b className="truncate">{w.item.name}</b>
                <span className="badge work-kind" title={KIND[w.kind].title}>
                  {KIND[w.kind].label}
                </span>
                <span className="faint">{w.item.providerId}</span>
                {projectNames && (
                  <span className="faint truncate">
                    {projectNames.get(w.item.projectId) ?? '—'}
                  </span>
                )}
                {w.item.cardKey && <span className="mono faint">{w.item.cardKey}</span>}
              </span>
              <span className="work-facts faint num">
                {facts.map((f, i) => (
                  <span key={i} title={f.title}>
                    {f.text}
                  </span>
                ))}
              </span>
            </button>
            {/* State and actions share one centre line, beside both text lines. */}
            <span className="work-side">
              <span className={`work-state tone-${state.tone ?? 'idle'}`}>{state.text}</span>
              {actions?.(w)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
