import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { AgentSession, ProjectSummary } from '../../../shared/types';
import { api } from '../api';
import { serialPoll } from '../lib/serialPoll';
import { InboxIcon } from './icons';

// One place for everything waiting on you, from any page (PM-261): the sessions that are asking you
// to choose or approve something, and the ones whose restart failed. It reads the session list the
// Agents page already polls; answering happens in the session itself (the row opens it).

export interface InboxItem {
  session: AgentSession;
  reason: 'input' | 'restart-failed';
}

/** What needs a person, most urgent first. Orchestrator chats live on their own page. */
export function inboxItems(sessions: AgentSession[]): InboxItem[] {
  const items: InboxItem[] = [];
  for (const session of sessions) {
    if (session.orchestratorId || session.status !== 'running') continue;
    if (session.tailState === 'input') items.push({ session, reason: 'input' });
    else if (session.restartProgress === 'failed')
      items.push({ session, reason: 'restart-failed' });
  }
  const rank = (i: InboxItem) => (i.reason === 'input' ? 0 : 1);
  return items.sort((a, b) => rank(a) - rank(b) || a.session.id - b.session.id);
}

const REASON = {
  input: 'Asking you to choose or approve something',
  'restart-failed': 'Restart failed',
} as const;

const POLL_MS = 5_000;

export function InboxButton() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Only while the tab is visible, and one request at a time.
  useEffect(
    () =>
      serialPoll(async () => setItems(inboxItems(await api.listAllSessions())), POLL_MS, {
        pauseWhenHidden: true,
      }),
    [],
  );

  useEffect(() => {
    if (!open) return;
    void api.listProjects().then(setProjects, () => undefined);
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const name = new Map(projects.map((p) => [p.id, p.name]));
  const count = items.length;
  return (
    <div className="inbox" ref={root}>
      <button
        type="button"
        className={`inbox-button${count > 0 ? ' has-items' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={count > 0 ? `Inbox, ${count} waiting for you` : 'Inbox, nothing waiting'}
        title="What is waiting for you"
        onClick={() => setOpen((v) => !v)}
      >
        <InboxIcon />
        {count > 0 && <span className="inbox-count">{count}</span>}
      </button>
      {open && (
        <div className="inbox-panel" role="dialog" aria-label="Inbox">
          <div className="inbox-head">Waiting for you</div>
          {count === 0 ? (
            <p className="inbox-empty">
              Nothing is waiting. Agents that need a decision appear here.
            </p>
          ) : (
            <ul>
              {items.map(({ session, reason }) => (
                <li key={session.id}>
                  <Link
                    to={`/workspace?open=${session.id}`}
                    onClick={() => setOpen(false)}
                    className="inbox-row"
                  >
                    <span className="inbox-dot" data-reason={reason} aria-hidden="true" />
                    <span className="inbox-main">
                      <span className="inbox-title">
                        {session.name}
                        {session.cardKey ? ` · ${session.cardKey}` : ''}
                      </span>
                      <span className="inbox-sub">
                        {name.get(session.projectId) ?? `Project ${session.projectId}`} ·{' '}
                        {REASON[reason]}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
