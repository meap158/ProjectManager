import type { ReactNode } from 'react';
import type { AgentRun, AgentSession, AgentTokenUsage } from '../../../shared/types';
import {
  formatBytes,
  formatCompact,
  formatDate,
  formatDuration,
  formatNumber,
  formatRelative,
} from '../format';
import { ACTIVITY_LABEL, sessionActivity } from '../sessionActivity';
import { InlineRename } from './InlineRename';
import { PROVIDER_LABELS, ProviderIcon } from './icons';

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
  /** Repeats what another fact already says roughly; the phone layout drops it for space. */
  minor?: boolean;
}

export function sessionFacts(s: AgentSession, now: number, usage?: AgentTokenUsage | null): Fact[] {
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
    minor: true,
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
  if (usage && usage.replies > 0) {
    // New tokens processed: input + cache writes + output. Cache reads (re-read context) are
    // listed in the tooltip; counting them would inflate the total many times over.
    const total = usage.input + usage.cacheWrite + usage.output;
    facts.push({
      text: `${formatCompact(total)} tokens`,
      title: [
        `${formatNumber(total)} tokens over ${usage.replies} replies, from Claude's session transcript`,
        `Input ${formatNumber(usage.input)} · cache writes ${formatNumber(usage.cacheWrite)} · output ${formatNumber(usage.output)}`,
        `Cache reads ${formatNumber(usage.cacheRead)} (context re-read, not included)`,
      ].join('\n'),
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

/** Filter buckets for the list view; one per item. */
export type WorkStatus = 'running' | 'idle' | 'review' | 'ended';

export const WORK_STATUS_LABELS: Record<WorkStatus, string> = {
  running: 'Running',
  idle: 'Idle',
  review: 'Needs review',
  ended: 'Ended',
};

/** Which status bucket an item is in (same rules as the row's state word). */
export function workStatus(w: WorkItem, now: number): WorkStatus {
  if (w.kind === 'session') {
    const activity = sessionActivity(w.item, now);
    return activity === 'stopped' ? 'ended' : activity;
  }
  const r = w.item;
  if (r.status === 'running' || r.status === 'queued') return 'running';
  if ((r.status === 'succeeded' || r.status === 'failed') && !r.validation) return 'review';
  return 'ended';
}

/** What the row says about state, in words (never colour alone). */
function stateLabel(
  w: WorkItem,
  now: number,
): { text: string; tone?: 'good' | 'bad' | 'attention'; activity?: 'running' | 'idle' } {
  if (w.kind === 'session') {
    const s = w.item;
    const activity = sessionActivity(s, now);
    if (activity !== 'stopped') return { text: ACTIVITY_LABEL[activity], tone: 'good', activity };
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
  onRename,
}: {
  items: WorkItem[];
  selected: WorkKey | null;
  onSelect: (key: WorkKey) => void;
  now: number;
  /** Token usage by session id, where the CLI exposes it. */
  tokens?: Record<number, AgentTokenUsage | null>;
  /** Shown when the list spans several projects. */
  projectNames?: Map<number, string>;
  actions?: (w: WorkItem) => ReactNode;
  /** Rename a session or run straight from its row (click its name). */
  onRename?: (w: WorkItem, name: string) => Promise<unknown>;
}) {
  return (
    <ul className="list work-list">
      {items.map((w) => {
        const key = workKey(w);
        const state = stateLabel(w, now);
        const providerLabel = PROVIDER_LABELS[w.item.providerId] ?? w.item.providerId;
        const facts =
          w.kind === 'session'
            ? sessionFacts(w.item, now, tokens?.[w.item.id])
            : runFacts(w.item, now);
        return (
          <li key={key} className={key === selected ? 'selected' : undefined}>
            {/* Clicking the row selects it; the name renames in place (its click stops here);
                the select button keeps the row reachable from the keyboard. */}
            <div
              className="work-row"
              onClick={() => onSelect(key)}
              title={
                w.kind === 'session'
                  ? `${w.item.command.join(' ')}\n${w.item.cwd}`
                  : w.item.prompt || w.item.command.join(' ')
              }
            >
              <span className="work-line">
                <button
                  type="button"
                  className="work-select"
                  aria-current={key === selected || undefined}
                  aria-label={`Show ${w.item.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(key);
                  }}
                >
                  <span
                    className={`status-dot tone-${state.tone ?? 'idle'}${state.activity ? ` is-${state.activity}` : ''}`}
                    aria-hidden="true"
                  />
                </button>
                {onRename ? (
                  <span className="work-name" onClick={(e) => e.stopPropagation()}>
                    <InlineRename
                      value={w.item.name}
                      label={w.kind === 'session' ? 'session' : 'run'}
                      onSave={(name) => onRename(w, name)}
                    />
                  </span>
                ) : (
                  <b className="truncate">{w.item.name}</b>
                )}
                <span className="work-provider" title={`Agent: ${providerLabel}`}>
                  <span className="work-provider-icon" aria-hidden="true">
                    <ProviderIcon id={w.item.providerId} size={14} />
                  </span>
                  <span className="faint">{providerLabel}</span>
                </span>
                <span className="badge work-kind" title={KIND[w.kind].title}>
                  {KIND[w.kind].label}
                </span>
                {projectNames && (
                  <span className="faint truncate">
                    {projectNames.get(w.item.projectId) ?? '—'}
                  </span>
                )}
              </span>
              <span className="work-facts faint num">
                {facts.map((f, i) => (
                  <span key={i} title={f.title} className={f.minor ? 'work-fact-minor' : undefined}>
                    {f.text}
                  </span>
                ))}
              </span>
            </div>
            {/* State and actions share one centre line, beside both text lines. */}
            <span className="work-side">
              {/* Card tag in a fixed right-hand column: tags line up, and names stay flush
                  left right after the status dot whether or not a row has a card. */}
              <span className="work-card-slot">
                {w.item.cardKey && (
                  <span className="badge mono work-card-tag" title="Card this work is on">
                    {w.item.cardKey}
                  </span>
                )}
              </span>
              <span className={`work-state tone-${state.tone ?? 'idle'}`}>{state.text}</span>
              {/* Fixed-width actions group (empty for runs) keeps the card and state columns at
                  the same x on every row. */}
              <span className="work-actions">{actions?.(w)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
