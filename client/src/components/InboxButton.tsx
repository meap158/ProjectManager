import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { AgentSession, ProjectSummary } from '../../../shared/types';
import { api } from '../api';
import { formatRelative, formatReset } from '../format';
import { sendAttentionCommand } from '../lib/attentionCommands';
import { serialPoll } from '../lib/serialPoll';
import { sessionActivity } from '../sessionActivity';
import {
  detectAttentionOverlay,
  promptStillShown,
  type AttentionCommand,
  type DetectedAttentionOverlay,
} from './BatchAttentionActions';
import { FilterChips, type FilterChip } from './FilterChips';
import { BellIcon, ProviderIcon } from './icons';

// One place for everything waiting on you, from any page (PM-261), answerable where it is listed.
// It reads the session list the Agents page already polls. Each row says what the session is ON,
// not only that it waits: the question it asks (with its choices as buttons), the reset time of a
// usage limit, the error of a failed restart, or the start of the reply you haven't read yet.
// Only while the panel is open are screens and transcripts read, and only for the rows it shows.

export type InboxReason = 'input' | 'restart-failed' | 'limit' | 'finished';

export interface InboxItem {
  session: AgentSession;
  reason: InboxReason;
  /** Identifies this occurrence: a finished turn comes back once you send the next message. */
  key: string;
  /**
   * Orders rows within a section: your last message for a finished turn, the restart time for a
   * failed one. Screen redraws keep moving lastOutputAt, so it is never used as a time here.
   */
  since: string | null;
}

const RANK: Record<InboxReason, number> = { input: 0, 'restart-failed': 1, limit: 2, finished: 3 };

/**
 * What needs a person, most urgent first: a question or approval, a failed restart, a usage
 * limit, then sessions that answered your last message and are waiting for the next one.
 * Orchestrator chats live on their own page.
 */
export function inboxItems(sessions: AgentSession[], now = Date.now()): InboxItem[] {
  const items: InboxItem[] = [];
  for (const session of sessions) {
    if (session.orchestratorId || session.status !== 'running') continue;
    const turn = session.lastInputAt ?? '';
    const item = (reason: InboxReason, since: string | null) =>
      items.push({ session, reason, key: `${session.id}:${reason}:${turn}`, since });
    if (session.restartProgress === 'failed') item('restart-failed', session.lastRestartAt);
    else if (session.tailState === 'input') item('input', null);
    else if (session.usageLimit) item('limit', null);
    else if (
      sessionActivity(session, now) === 'idle' &&
      session.lastInputAt &&
      session.lastOutputAt &&
      session.lastOutputAt > session.lastInputAt
    )
      // The turn (your last message) is the key: it comes back after your next one.
      item('finished', session.lastInputAt);
  }
  return items.sort(
    (a, b) =>
      RANK[a.reason] - RANK[b.reason] ||
      (b.since ?? '').localeCompare(a.since ?? '') ||
      a.session.id - b.session.id,
  );
}

const REASON: Record<InboxReason, string> = {
  input: 'Needs your decision',
  'restart-failed': 'Restart failed',
  limit: 'Paused at its usage limit',
  finished: 'Replied · your turn',
};

const SECTION: Record<InboxReason, string> = {
  input: 'Needs a decision',
  'restart-failed': 'Problems',
  limit: 'Usage limits',
  finished: 'Finished · your turn',
};

/** The chips over the list: everything, only what is new, or one kind. */
export type InboxFilter = 'all' | 'new' | InboxReason;
const TONE: Record<InboxReason, string> = {
  input: 'review',
  'restart-failed': 'danger',
  limit: 'progress',
  finished: 'accent',
};
const FILTER_KEY = 'pm.inbox.filter';

function loadFilter(): InboxFilter {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return v === 'new' || (v !== null && v in SECTION) ? (v as InboxFilter) : 'all';
  } catch {
    return 'all';
  }
}

const CHIP: Record<InboxReason, string> = {
  input: 'Decisions',
  'restart-failed': 'Problems',
  limit: 'Limits',
  finished: 'Your turn',
};

const POLL_MS = 5_000;
/** Rows whose screen or reply is read when the panel opens. */
const DETAIL_ROWS = 12;
const SEEN_KEY = 'pm.inbox.seen';

function loadSeen(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveSeen(keys: Set<string>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...keys]));
  } catch {
    // Private windows and blocked storage: seen state just lasts until reload.
  }
}

interface Detail {
  overlay: DetectedAttentionOverlay | null;
  /** The start of the last assistant message, and when it was written, for finished turns. */
  reply: string | null;
  replyAt: string | null;
}

/** First lines of the newest assistant message, flattened to one paragraph. */
async function lastReply(id: number): Promise<{ text: string; at: string | null } | null> {
  const { items } = await api.sessionTranscript(id);
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === 'user') return null;
    if (item.kind === 'assistant' && item.text?.trim())
      return {
        text: item.text
          .replace(/[#*_`>]+/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 280),
        at: item.at,
      };
  }
  return null;
}

export function InboxButton() {
  const [items, setItems] = useState<InboxItem[]>([]);
  /** When the list was last read: the clock reset times count from. */
  const [now, setNow] = useState(() => Date.now());
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<Set<string>>(loadSeen);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [filter, setFilterState] = useState<InboxFilter>(loadFilter);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  const refresh = async () => {
    const sessions = await api.listAllSessions();
    const at = Date.now();
    setNow(at);
    setItems(inboxItems(sessions, at));
  };

  // Only while the tab is visible, and one request at a time.
  useEffect(() => serialPoll(refresh, POLL_MS, { pauseWhenHidden: true }), []);

  useEffect(() => {
    if (!open) return;
    void api.listProjects().then(setProjects, () => undefined);
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const isNew = (i: InboxItem) => !seen.has(i.key);
  const matches = (i: InboxItem, f: InboxFilter) =>
    f === 'all' || (f === 'new' ? isNew(i) : i.reason === f);
  // A chip whose rows are all gone falls back to everything, so the list is never empty by filter.
  const active: InboxFilter = items.some((i) => matches(i, filter)) ? filter : 'all';
  const shown = items.filter((i) => matches(i, active));

  // Read each shown row's screen (its question, if any) and, for a finished turn, its reply.
  // Keyed by occurrence, so a row is read again only when it changes.
  const detailKeys = shown
    .slice(0, DETAIL_ROWS)
    .filter((i) => i.reason !== 'restart-failed')
    .map((i) => i.key);
  const pending = open ? detailKeys.filter((k) => !(k in details)).join('|') : '';
  useEffect(() => {
    if (!pending) return;
    let live = true;
    const wanted = items.filter((i) => pending.split('|').includes(i.key));
    void Promise.all(
      wanted.map(async ({ session, reason, key }): Promise<[string, Detail]> => {
        const overlay = await api.sessionScreen(session.id).then(
          ({ text }) => detectAttentionOverlay(text, session),
          () => null,
        );
        const reply =
          reason === 'finished' && !overlay ? await lastReply(session.id).catch(() => null) : null;
        return [key, { overlay, reply: reply?.text ?? null, replyAt: reply?.at ?? null }];
      }),
    ).then((rows) => {
      if (live) setDetails((d) => ({ ...d, ...Object.fromEntries(rows) }));
    });
    return () => {
      live = false;
    };
    // `pending` names exactly the rows to read; `items` is read for their sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  const name = new Map(projects.map((p) => [p.id, p.name]));
  const unseen = items.filter((i) => !seen.has(i.key));
  const count = unseen.length;
  const needs = items.filter((i) => i.reason !== 'finished').length;

  function markSeen(keys: string[]) {
    // Forget occurrences that are gone, so the list can't grow forever.
    const live = new Set(items.map((i) => i.key));
    const next = new Set([...seen].filter((k) => live.has(k)));
    for (const k of keys) next.add(k);
    setSeen(next);
    saveSeen(next);
  }

  async function act(item: InboxItem, label: string, run: () => Promise<string | void>) {
    if (busy) return;
    setBusy(item.key);
    setNotes((n) => ({ ...n, [item.key]: '' }));
    try {
      const note = await run();
      setNotes((n) => ({ ...n, [item.key]: note ?? `${label}: sent.` }));
      markSeen([item.key]);
      void refresh().catch(() => undefined);
    } catch (error) {
      setNotes((n) => ({
        ...n,
        [item.key]: `${label} failed: ${error instanceof Error ? error.message : 'request failed'}`,
      }));
    } finally {
      setBusy(null);
    }
  }

  function choose(
    item: InboxItem,
    overlay: DetectedAttentionOverlay,
    label: string,
    cmd: AttentionCommand,
  ) {
    void act(item, label, async () => {
      // The question may have moved on since the panel read it: never answer a different one.
      if (
        (cmd.kind === 'key' || cmd.kind === 'line') &&
        !(await promptStillShown(item.session, overlay))
      ) {
        setDetails(({ [item.key]: _gone, ...rest }) => rest);
        return 'The prompt changed. Check the new one below.';
      }
      const queued = await sendAttentionCommand(item.session, cmd);
      return queued ? `${label}: queued until it reconnects.` : `${label}: sent.`;
    });
  }

  function reply(item: InboxItem, e: FormEvent) {
    e.preventDefault();
    const text = (replies[item.key] ?? '').trim();
    if (!text) return;
    void act(item, 'Reply', async () => {
      const queued = await sendAttentionCommand(item.session, { kind: 'line', text });
      setReplies((r) => ({ ...r, [item.key]: '' }));
      return queued ? 'Reply queued until it reconnects.' : 'Reply sent.';
    });
  }

  const sections = (Object.keys(SECTION) as InboxReason[])
    .map((reason) => ({ reason, rows: shown.filter((i) => i.reason === reason) }))
    .filter((s) => s.rows.length > 0);
  const reading = new Set(detailKeys);

  const setFilter = (f: InboxFilter) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {
      // Remembered for this visit only.
    }
  };
  const chips: FilterChip<InboxFilter>[] = [
    { key: 'all', label: 'All', count: items.length },
    { key: 'new', label: 'New', count: count },
    ...(Object.keys(SECTION) as InboxReason[])
      .map((reason) => ({
        key: reason,
        label: CHIP[reason],
        count: items.filter((i) => i.reason === reason).length,
        tone: TONE[reason],
      }))
      .filter((c) => c.count > 0),
  ];

  return (
    <div className="inbox" ref={root}>
      <button
        ref={button}
        type="button"
        className={`inbox-button${count > 0 ? ' has-items' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={count > 0 ? `Inbox, ${count} waiting for you` : 'Inbox, nothing new'}
        title="What is waiting for you"
        onClick={() => setOpen((v) => !v)}
      >
        <BellIcon size={18} filled={count > 0} />
        {count > 0 && (
          <span className={`inbox-count${needs > 0 ? ' is-urgent' : ''}`} aria-hidden="true">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>
      {open && (
        <div className="inbox-panel" role="dialog" aria-label="Inbox">
          <div className="inbox-sticky">
            <header className="inbox-head">
              <div>
                <h2>Inbox</h2>
                <p>
                  {items.length === 0
                    ? 'You are all caught up'
                    : [
                        needs ? `${needs} need${needs === 1 ? 's' : ''} you` : '',
                        count ? `${count} new` : 'nothing new',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                </p>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={count === 0}
                onClick={() => markSeen(items.map((i) => i.key))}
              >
                Mark all seen
              </button>
            </header>
            {items.length > 0 && (
              <div className="inbox-filters">
                <FilterChips
                  chips={chips}
                  selected={active}
                  onSelect={setFilter}
                  label="Show in the inbox"
                />
              </div>
            )}
          </div>
          {items.length === 0 ? (
            <p className="inbox-empty">
              <strong>Nothing is waiting.</strong> Questions, approvals, usage limits, failed
              restarts and finished replies appear here.
            </p>
          ) : (
            sections.map(({ reason, rows }) => (
              <section key={reason} className="inbox-section" aria-label={SECTION[reason]}>
                <h3>
                  {SECTION[reason]} <span>{rows.length}</span>
                </h3>
                <ul>
                  {rows.map((item) => {
                    const { session, key } = item;
                    const detail = details[key];
                    const isSeen = seen.has(key);
                    const note = notes[key];
                    // Only times that mean something: when the reply was written, or when the
                    // restart failed. A prompt's screen redraws give no honest "since".
                    const when =
                      item.reason === 'restart-failed' ? item.since : (detail?.replyAt ?? null);
                    return (
                      <li
                        key={key}
                        className={`inbox-item${isSeen ? ' is-seen' : ''}`}
                        data-reason={item.reason}
                      >
                        <div className="inbox-top">
                          <ProviderIcon id={session.providerId} size={14} />
                          <Link
                            to={`/workspace?open=${session.id}`}
                            onClick={() => {
                              markSeen([key]);
                              setOpen(false);
                            }}
                            className="inbox-title"
                          >
                            {session.name}
                            {session.cardKey ? ` · ${session.cardKey}` : ''}
                          </Link>
                          {when && (
                            <time
                              className="inbox-time"
                              dateTime={when}
                              title={new Date(when).toLocaleString()}
                            >
                              {formatRelative(when)}
                            </time>
                          )}
                        </div>
                        <div className="inbox-sub">
                          {name.get(session.projectId) ?? `Project ${session.projectId}`} ·{' '}
                          {REASON[item.reason]}
                        </div>
                        <InboxContext
                          item={item}
                          detail={detail}
                          now={now}
                          reading={reading.has(key)}
                        />
                        {detail?.overlay && (
                          <div
                            className="inbox-choices"
                            role="group"
                            aria-label={detail.overlay.title}
                          >
                            {detail.overlay.options.map((o) => (
                              <button
                                key={o.key}
                                type="button"
                                className="btn btn-sm"
                                title={o.detail}
                                disabled={busy !== null}
                                onClick={() => choose(item, detail.overlay!, o.label, o.command)}
                              >
                                {o.label}
                              </button>
                            ))}
                            {skipsChoices(detail.overlay) && (
                              <span className="inbox-more">Open it for every choice.</span>
                            )}
                          </div>
                        )}
                        {item.reason === 'restart-failed' && (
                          <div className="inbox-choices">
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              disabled={busy !== null}
                              onClick={() =>
                                void act(item, 'Restart', async () => {
                                  await api.restartSession(session.id);
                                  return 'Restarting.';
                                })
                              }
                            >
                              Restart
                            </button>
                          </div>
                        )}
                        {item.reason === 'finished' && !detail?.overlay && (
                          <form className="inbox-reply" onSubmit={(e) => reply(item, e)}>
                            <input
                              className="input"
                              value={replies[key] ?? ''}
                              onChange={(e) => setReplies((r) => ({ ...r, [key]: e.target.value }))}
                              placeholder="Reply…"
                              aria-label={`Reply to ${session.name}`}
                              disabled={busy !== null}
                            />
                            <button
                              type="submit"
                              className="btn btn-sm btn-primary"
                              disabled={busy !== null || !(replies[key] ?? '').trim()}
                            >
                              Send
                            </button>
                          </form>
                        )}
                        <footer className="inbox-foot">
                          {note ? (
                            <span className="inbox-note" role="status">
                              {note}
                            </span>
                          ) : (
                            <span />
                          )}
                          {isSeen ? (
                            <span className="inbox-seen">Seen</span>
                          ) : (
                            <button
                              type="button"
                              className="inbox-dismiss"
                              onClick={() => markSeen([key])}
                            >
                              Mark seen
                            </button>
                          )}
                        </footer>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** A long option can wrap past what the screen parser reads: say so when numbers are missing. */
function skipsChoices(overlay: DetectedAttentionOverlay): boolean {
  const nums = overlay.options
    .map((o) => /^(\d+)\./.exec(o.label)?.[1])
    .filter(Boolean)
    .map(Number);
  return nums.some((n, i) => i > 0 && n !== nums[i - 1]! + 1);
}

/** The one line that says what the row is about. Nothing is shown rather than a guess. */
function InboxContext({
  item,
  detail,
  now,
  reading,
}: {
  item: InboxItem;
  detail: Detail | undefined;
  now: number;
  /** Its screen is being read (only the first rows of the list are). */
  reading: boolean;
}) {
  const { session } = item;
  if (item.reason === 'restart-failed')
    return session.restartError ? (
      <p className="inbox-context is-error">{session.restartError}</p>
    ) : null;
  if (item.reason === 'limit') {
    const at = session.usageLimit?.resetsAt;
    return (
      <p className="inbox-context">
        {at ? `Resets ${formatReset(at, now)}.` : 'Reset time unknown.'}
        {session.autoContinue?.enabled ? ' Continues on its own then.' : ''}
      </p>
    );
  }
  if (!detail)
    return reading ? <p className="inbox-context is-loading">Reading its screen…</p> : null;
  if (detail.overlay) return <p className="inbox-context is-question">{detail.overlay.title}</p>;
  if (detail.reply) return <p className="inbox-context is-reply">{detail.reply}</p>;
  return item.reason === 'input' ? (
    <p className="inbox-context">Open it to see what it asks.</p>
  ) : null;
}
