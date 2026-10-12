import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AgentSession, ChatItem } from '../../../shared/types';
import { api } from '../api';
import { serialPoll } from '../lib/serialPoll';
import './session-chat.css';

// Chat view of an agent session (mobile). A terminal UI is heavy on a phone: xterm redraws a
// full screen of cells, scrolls in whole rows and fights the on-screen keyboard. This view
// renders the CLI's own transcript (messages, tool calls, results) as native, smoothly
// scrolling chat, with a composer that types into the same session and, while the CLI asks
// something, its current screen with quick keys. Nothing is dropped: tool inputs and outputs
// open in place, and the terminal stays one tap away.

/** Kept in memory; older items stay in the transcript file (the terminal shows them all too). */
const MAX_ITEMS = 1500;
const POLL_MS = 1500;
const CHAT_PROVIDERS = new Set(['claude', 'codex']);

/** Sessions whose CLI writes a transcript the chat view can read. */
export const chatSupported = (session: AgentSession) =>
  session.terminal === 'pty' && CHAT_PROVIDERS.has(session.providerId);

const KEYS: { label: string; aria: string; data: string }[] = [
  { label: 'Esc', aria: 'Escape', data: '\x1b' },
  { label: '↑', aria: 'Arrow up', data: '\x1b[A' },
  { label: '↓', aria: 'Arrow down', data: '\x1b[B' },
  { label: '⏎', aria: 'Enter', data: '\r' },
  { label: '1', aria: '1', data: '1' },
  { label: '2', aria: '2', data: '2' },
  { label: '3', aria: '3', data: '3' },
  { label: '^C', aria: 'Interrupt (Control C)', data: '\x03' },
];

/** Tool calls with their results attached, in order. */
interface Entry {
  item: ChatItem;
  result?: ChatItem;
}

function merge(items: ChatItem[]): Entry[] {
  const entries: Entry[] = [];
  const byTool = new Map<string, Entry>();
  for (const item of items) {
    if (item.kind === 'result') {
      const call = item.toolId ? byTool.get(item.toolId) : undefined;
      if (call) call.result = item;
      continue; // A result without its call (outside the loaded tail) has nothing to attach to.
    }
    const entry: Entry = { item };
    if (item.kind === 'tool' && item.toolId) byTool.set(item.toolId, entry);
    entries.push(entry);
  }
  return entries;
}

/** Inline Markdown: `code` and **bold**. */
function inline(text: string, key: string): ReactNode {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/);
  return (
    <span key={key}>
      {parts.map((part, j) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 1 ? (
          <code key={j}>{part.slice(1, -1)}</code>
        ) : part.startsWith('**') && part.endsWith('**') && part.length > 3 ? (
          <strong key={j}>{part.slice(2, -2)}</strong>
        ) : (
          part
        ),
      )}
    </span>
  );
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

/** Prose with headings and tables: tables become real tables (scrolling sideways on phones). */
function prose(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = text.split('\n');
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length) out.push(inline(buffer.join('\n'), `${key}-p${out.length}`));
    buffer = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isTable = /^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '');
    if (isTable) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      i--;
      out.push(
        <div key={`${key}-t${i}`} className="chat-table-wrap">
          <table className="chat-table">
            <thead>
              <tr>
                {head.map((h, c) => (
                  <th key={c}>{inline(h, `h${c}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((cell, c) => (
                    <td key={c}>{inline(cell, `c${c}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push(
        <div key={`${key}-h${i}`} className="chat-heading">
          {inline(heading[2]!, 'h')}
        </div>,
      );
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out;
}

/** Light Markdown: fenced code blocks, then prose (tables, headings, `code`, **bold**). */
function renderText(text: string): ReactNode[] {
  return text.split(/```[\w-]*\n?/).flatMap<ReactNode>((block, i) =>
    i % 2 === 1
      ? [
          <pre key={i} className="chat-code">
            {block.replace(/\n$/, '')}
          </pre>,
        ]
      : prose(block, String(i)),
  );
}

const Message = memo(function Message({ item }: { item: ChatItem }) {
  return (
    <div className={`chat-msg is-${item.kind}`}>
      <div className="chat-bubble">{renderText(item.text ?? '')}</div>
    </div>
  );
});

const ToolCall = memo(function ToolCall({ entry }: { entry: Entry }) {
  const { item, result } = entry;
  const state = !result ? 'running' : result.isError ? 'error' : 'done';
  return (
    <details className={`chat-tool is-${state}`}>
      <summary>
        <span className="chat-tool-state" aria-label={state} />
        <span className="chat-tool-name">{item.name}</span>
        <span className="chat-tool-summary">{item.summary}</span>
      </summary>
      {item.input && (
        <>
          <div className="chat-tool-label">Input</div>
          <pre className="chat-code">{item.input}</pre>
        </>
      )}
      {result && (
        <>
          <div className="chat-tool-label">{result.isError ? 'Error' : 'Output'}</div>
          <pre className="chat-code">{result.text || '(no output)'}</pre>
        </>
      )}
    </details>
  );
});

/** Messages stay as they are; runs of consecutive tool calls become one group. */
type Block = { kind: 'message'; entry: Entry } | { kind: 'steps'; id: string; steps: Entry[] };

function blocks(entries: Entry[]): Block[] {
  const out: Block[] = [];
  for (const entry of entries) {
    const last = out.at(-1);
    if (entry.item.kind !== 'tool') out.push({ kind: 'message', entry });
    else if (last?.kind === 'steps') last.steps.push(entry);
    else out.push({ kind: 'steps', id: entry.item.id, steps: [entry] });
  }
  return out;
}

/**
 * A run of tool calls as one row, like chat apps do: how many steps, which tools, the latest
 * step, and whether one is still running. Tap to see every step with its input and output.
 */
const Steps = memo(function Steps({ steps }: { steps: Entry[] }) {
  if (steps.length === 1) return <ToolCall entry={steps[0]!} />;
  const latest = steps.at(-1)!;
  const running = steps.some((s) => !s.result);
  const failed = steps.some((s) => s.result?.isError);
  const tools = [...new Set(steps.map((s) => s.item.name))].slice(0, 4).join(', ');
  return (
    <details className={`chat-steps is-${running ? 'running' : failed ? 'error' : 'done'}`}>
      <summary>
        <span className="chat-tool-state" aria-hidden="true" />
        <span className="chat-steps-count">{steps.length} steps</span>
        <span className="chat-tool-summary">
          {tools} · {latest.item.summary || latest.item.name}
        </span>
      </summary>
      <div className="chat-steps-list">
        {steps.map((s) => (
          <ToolCall key={s.item.id} entry={s} />
        ))}
      </div>
    </details>
  );
});

export function SessionChat({
  session,
  onError,
}: {
  session: AgentSession;
  onError: (message: string) => void;
}) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [supported, setSupported] = useState(true);
  const [screen, setScreen] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const next = useRef<number | undefined>(undefined);
  const id = session.id;
  const asking = session.status === 'running' && session.tailState === 'input';
  const working = session.status === 'running' && session.tailState === 'running';

  // Transcript: the tail first, then what was appended; refreshes only while visible.
  useEffect(() => {
    // Mounted per session (key): a new session starts from a fresh state.
    let active = true;
    const poll = () =>
      api.sessionTranscript(id, next.current).then((t) => {
        if (!active) return;
        setSupported(t.supported);
        setLoaded(true);
        next.current = t.next;
        if (!t.items.length && !t.reset) return;
        setItems((prev) => {
          const merged = t.reset ? t.items : [...prev, ...t.items];
          return merged.length > MAX_ITEMS ? merged.slice(-MAX_ITEMS) : merged;
        });
        if (!atBottom.current)
          setUnseen((n) => n + t.items.filter((i) => i.kind === 'assistant').length);
      });
    let stop: (() => void) | null = null;
    const sync = () => {
      if (document.visibilityState === 'visible') stop ??= serialPoll(poll, POLL_MS);
      else {
        stop?.();
        stop = null;
      }
    };
    if (document.visibilityState !== 'visible') void poll().catch(() => undefined);
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      active = false;
      stop?.();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [id]);

  // The CLI's screen while it asks you something (a choice, a permission): answer from here.
  useEffect(() => {
    if (!asking) return;
    let active = true;
    const stop = serialPoll(
      () =>
        api.sessionScreen(id).then((s) => {
          if (active) setScreen(s.text);
        }),
      POLL_MS,
    );
    return () => {
      active = false;
      stop();
    };
  }, [id, asking]);

  // Follow new messages while at the bottom; otherwise count them on a "new messages" pill.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && atBottom.current) list.scrollTop = list.scrollHeight;
  }, [items, screen, working]);
  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    atBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    if (atBottom.current) setUnseen(0);
  };
  const jumpToLatest = () => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    atBottom.current = true;
    setUnseen(0);
  };

  const send = useCallback(
    (data: string) =>
      api.sendSessionInput(id, data).catch((e: Error) => {
        onError(e.message);
        throw e;
      }),
    [id, onError],
  );
  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      // Bracketed paste keeps multi-line messages in one prompt; Enter submits it.
      await send(`\x1b[200~${text}\x1b[201~`);
      await send('\r');
      setDraft('');
      atBottom.current = true;
    } catch {
      // Shown by onError; the draft stays so nothing typed is lost.
    } finally {
      setSending(false);
    }
  };

  const entries = merge(items);
  return (
    <div className="session-chat">
      <div className="chat-list" ref={listRef} onScroll={onScroll} aria-live="polite">
        {!loaded ? (
          <div className="skeleton" style={{ height: 120, margin: 12 }} />
        ) : !supported ? (
          <p className="chat-empty">This CLI has no readable transcript: use the terminal view.</p>
        ) : !entries.length ? (
          <p className="chat-empty">No messages yet. Send one below.</p>
        ) : (
          blocks(entries).map((b) =>
            b.kind === 'steps' ? (
              <Steps key={b.id} steps={b.steps} />
            ) : (
              <Message key={b.entry.item.id} item={b.entry.item} />
            ),
          )
        )}
        {working && (
          <div className="chat-working" role="status">
            <span className="chat-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            Working…
          </div>
        )}
        {asking && (
          <div className="chat-asking" role="status">
            <div className="chat-tool-label">The CLI is asking:</div>
            <pre className="chat-code">{screen || 'Reading the screen…'}</pre>
          </div>
        )}
      </div>
      {unseen > 0 && (
        <button type="button" className="chat-new" onClick={jumpToLatest}>
          {unseen} new message{unseen === 1 ? '' : 's'} ↓
        </button>
      )}
      <div className="chat-keys" role="group" aria-label="Terminal keys">
        {KEYS.map((k) => (
          <button
            key={k.aria}
            type="button"
            className="chat-key"
            aria-label={k.aria}
            onClick={() => void send(k.data).catch(() => undefined)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          className="input chat-input"
          value={draft}
          rows={1}
          placeholder={
            session.status === 'running' ? 'Message…' : 'Session is down: queues for relaunch'
          }
          aria-label="Message to the session"
          onChange={(e) => {
            setDraft(e.target.value);
            // Grow with the text, up to about six lines.
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
          }}
          onKeyDown={(e) => {
            // Phones: Return adds a line (send with the button). Keyboards: Ctrl/⌘+Enter sends.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button
          type="submit"
          className="btn btn-primary chat-send"
          disabled={!draft.trim() || sending}
        >
          Send
        </button>
      </form>
    </div>
  );
}

export type SessionView = 'chat' | 'terminal';
const VIEW_KEY = 'pm.sessionView';

/**
 * Chat or terminal for a session pane: offered on phones and touch screens for CLIs with a
 * transcript, Chat by default there; remembered per device. Elsewhere always the terminal.
 */
export function useSessionView(session: AgentSession | null) {
  const [mobile, setMobile] = useState(
    () => window.matchMedia?.('(max-width: 768px), (pointer: coarse)').matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 768px), (pointer: coarse)');
    if (!query) return;
    const change = () => setMobile(query.matches);
    // Safari before 14 only has the older addListener API.
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', change);
      return () => query.removeEventListener('change', change);
    }
    query.addListener?.(change);
    return () => query.removeListener?.(change);
  }, []);
  const [preferred, setPreferred] = useState<SessionView>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'terminal' ? 'terminal' : 'chat';
    } catch {
      return 'chat';
    }
  });
  const available = mobile && !!session && chatSupported(session);
  const choose = (view: SessionView) => {
    setPreferred(view);
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // Remembering the view is a convenience only.
    }
  };
  return { view: available ? preferred : ('terminal' as SessionView), available, choose };
}

/** The Chat / Terminal switch for a pane header. */
export function ViewSwitch({
  view,
  onChange,
}: {
  view: SessionView;
  onChange: (view: SessionView) => void;
}) {
  return (
    <div className="session-view-switch" role="group" aria-label="Session view">
      {(['chat', 'terminal'] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          aria-label={v === 'chat' ? 'Chat' : 'Terminal'}
          onClick={() => onChange(v)}
        >
          {v === 'chat' ? 'Chat' : 'CLI'}
        </button>
      ))}
    </div>
  );
}
