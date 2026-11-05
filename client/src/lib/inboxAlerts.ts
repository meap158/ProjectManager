import type { AgentSession } from '../../../shared/types';
import type { InboxItem } from '../components/InboxButton';

/*
 * Desktop notifications for what needs a person (PM-429), so work that runs on its own can reach
 * the owner while the app is in a background tab. Off by default and per browser. Only the urgent
 * Inbox reasons notify (a decision, a question, a failed restart), plus an orchestrator chat that
 * is asking something; finished replies and usage limits stay in the Inbox. Each occurrence
 * notifies once: its key is remembered, and the notification's tag lets the system replace a
 * duplicate from a second tab.
 */

export interface InboxAlert {
  key: string;
  title: string;
  body: string;
  /** Where clicking the notification goes. */
  path: string;
}

const NOTIFY_KEY = 'pm.inbox.notify';
const SENT_KEY = 'pm.inbox.notified';
/** Keys kept to avoid repeats; older ones are gone from the session list anyway. */
const SENT_LIMIT = 200;

const URGENT: Partial<Record<InboxItem['reason'], string>> = {
  input: 'needs your decision',
  asked: 'is asking you something',
  'restart-failed': 'failed to restart',
};

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && window.isSecureContext;
}

export function loadNotify(): boolean {
  try {
    return localStorage.getItem(NOTIFY_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveNotify(on: boolean) {
  try {
    if (on) localStorage.setItem(NOTIFY_KEY, '1');
    else localStorage.removeItem(NOTIFY_KEY);
  } catch {
    // Blocked storage: the choice lasts until reload.
  }
}

export function loadSent(): string[] {
  try {
    const raw = localStorage.getItem(SENT_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function saveSent(keys: readonly string[]) {
  try {
    localStorage.setItem(SENT_KEY, JSON.stringify(keys.slice(-SENT_LIMIT)));
  } catch {
    // Without storage a reload may notify a waiting item once more.
  }
}

const label = (session: AgentSession, names: ReadonlyMap<number, string>) =>
  session.name?.trim() || names.get(session.projectId) || `Session ${session.id}`;

/** Everything that would notify right now, from the Inbox rows and the full session list. */
export function inboxAlerts(
  items: readonly InboxItem[],
  sessions: readonly AgentSession[],
  names: ReadonlyMap<number, string> = new Map(),
): InboxAlert[] {
  const alerts: InboxAlert[] = [];
  for (const item of items) {
    const what = URGENT[item.reason];
    if (!what) continue;
    const project = names.get(item.session.projectId);
    alerts.push({
      key: item.key,
      title: `${label(item.session, names)} ${what}`,
      body: [project, item.session.question?.trim()].filter(Boolean).join(': ').slice(0, 200),
      path: `/workspace?open=${item.session.id}`,
    });
  }
  // Orchestrator chats live on their own page and are left out of the Inbox.
  for (const s of sessions)
    if (s.orchestratorId && s.status === 'running' && s.tailState === 'input')
      alerts.push({
        key: `${s.id}:orchestrator-input:${s.lastInputAt ?? ''}`,
        title: 'An orchestrator is asking you something',
        body: 'Open its chat on the Orchestrators page.',
        path: '/orchestrators',
      });
  return alerts;
}

/**
 * The alerts to show now and the keys to remember. The first look after turning notifications on
 * (sent === null) only records what is already waiting: the Inbox shows those, and a burst of old
 * items would teach the owner to ignore the notifications.
 */
export function freshAlerts(
  alerts: readonly InboxAlert[],
  sent: readonly string[] | null,
): { show: InboxAlert[]; sent: string[] } {
  if (sent === null) return { show: [], sent: alerts.map((a) => a.key) };
  const known = new Set(sent);
  const show = alerts.filter((a) => !known.has(a.key));
  return { show, sent: [...sent, ...show.map((a) => a.key)] };
}
