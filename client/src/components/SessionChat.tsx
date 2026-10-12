import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import type { AgentSession, ChatItem } from '../../../shared/types';
import { api } from '../api';
import { serialPoll } from '../lib/serialPoll';
import { prepareImage } from '../sessionImages';
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

/**
 * The CLI's live status line from its screen: Claude Code "✻ Finagling… (7m 49s · ↓ 7.8k
 * tokens · thinking)", Codex "Working (8m 05s • esc to interrupt)". Null when none shows.
 */
export function statusLine(screen: string): string | null {
  const lines = screen.split('\n').map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (/…\s*\(\s*\d+[smh]/.test(line) || /^[•◦]?\s*working\s*\(\s*\d+[smh]/i.test(line))
      return line
        .replace(/^[^\p{L}]+/u, '') // Spinner glyph.
        .replace(/\s*[·•]\s*esc\s*to\s*interrupt/i, '')
        .replace(/\s+/g, ' ');
  }
  return null;
}

const draftKey = (id: number) => `pm.chatDraft.${id}`;
function readDraft(id: number): string {
  try {
    return sessionStorage.getItem(draftKey(id)) ?? '';
  } catch {
    return '';
  }
}
function saveDraft(id: number, text: string) {
  try {
    if (text) sessionStorage.setItem(draftKey(id), text);
    else sessionStorage.removeItem(draftKey(id));
  } catch {
    // Keeping the draft is a convenience only.
  }
}

/**
 * Switching from the chat to the terminal: the unsent message is typed into the CLI's input
 * line (no Enter), so the terminal shows the same draft; the chat keeps it too, and sending
 * clears that line first, so it never goes out twice. Done on the switch itself (not on
 * unmount, which development mode runs at every mount).
 */
export function handOffDraft(sessionId: number): void {
  const text = readDraft(sessionId).trim();
  if (!text) return;
  void api
    .sendSessionInput(sessionId, '\x05\x15')
    .then(() => api.sendSessionInput(sessionId, `\x1b[200~${text}\x1b[201~`))
    .catch(() => undefined);
}

/** An image waiting in the composer: uploaded, its path pasted into the CLI when sent. */
interface Attachment {
  path: string;
  name: string;
  /** A local preview (object URL), when the image came from this browser. */
  preview: string | null;
}

export function SessionChat({
  session,
  onError,
  pasteRef,
}: {
  session: AgentSession;
  onError: (message: string) => void;
  /**
   * The pane's paste target (its image button pastes uploaded paths through it): while the
   * chat shows, those images join the message instead of going to the hidden terminal.
   */
  pasteRef?: MutableRefObject<((text: string) => void) | null>;
}) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [supported, setSupported] = useState(true);
  const [screen, setScreen] = useState('');
  // The unsent message survives switching to the terminal and back (kept per session for this
  // browser tab); see the unmount effect below for what the terminal shows meanwhile.
  const [draft, setDraft] = useState(() => readDraft(session.id));
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

  // The CLI's screen while it asks you something (a choice, a permission: answer from here), or
  // while it works (its status line: what it's doing, time, tokens).
  useEffect(() => {
    if (!asking && !working) return;
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
  }, [id, asking, working]);
  const status = working ? statusLine(screen) : null;

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
  // Keep the draft as you type; switching to the terminal hands it over (handOffDraft).
  useEffect(() => saveDraft(id, draft), [id, draft]);
  const composer = useRef<HTMLTextAreaElement>(null);

  // Images (PM-116): pasted, dropped or picked into the composer, uploaded at once, and sent
  // with the message as their paths, which Claude Code and Codex attach as images.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const addImages = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    setUploading((n) => n + images.length);
    for (const file of images) {
      try {
        const { path } = await api.uploadSessionImage(id, await prepareImage(file));
        const name = file.name || 'image';
        setAttachments((prev) => [...prev, { path, name, preview: URL.createObjectURL(file) }]);
      } catch (e) {
        onError((e as Error).message);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  // The pane's image button uploads and pastes a path: while the chat shows, it joins here.
  useEffect(() => {
    if (!pasteRef) return;
    pasteRef.current = (path) =>
      setAttachments((prev) => [
        ...prev,
        { path, name: path.split(/[\\/]/).pop() ?? 'image', preview: null },
      ]);
    return () => {
      pasteRef.current = null;
    };
  }, [pasteRef]);
  const removeAttachment = (path: string) =>
    setAttachments((prev) => {
      const gone = prev.find((a) => a.path === path);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return prev.filter((a) => a.path !== path);
    });

  const submit = async () => {
    const text = draft.trim();
    const images = attachments;
    if ((!text && !images.length) || sending || uploading) return;
    setSending(true);
    // Shown in the chat at once (PM-116), until the CLI's transcript records it.
    const pendingId = ++pendingSeq.current;
    const shown = [...images.map((a) => `[image: ${a.name}]`), text].filter(Boolean).join('\n');
    setPending((prev) => [
      ...prev,
      { id: pendingId, text: text || shown, label: shown, due: false },
    ]);
    setDraft('');
    setAttachments([]);
    setRecall(null);
    atBottom.current = true;
    try {
      // Only what you typed: first clear anything already in the CLI's input line (Ctrl+E to
      // its end, Ctrl+U to delete it; e.g. text typed in the terminal view). Each image path
      // goes in as its own paste (that's how the CLIs recognise an image), then the text as
      // one bracketed paste (multi-line stays one prompt), and Enter submits it.
      await send('\x05\x15');
      for (const image of images) await send(`\x1b[200~${image.path}\x1b[201~`);
      if (text) await send(`\x1b[200~${text}\x1b[201~`);
      await send('\r');
      for (const image of images) if (image.preview) URL.revokeObjectURL(image.preview);
      if (text) setSent((prev) => [...prev, text]);
      // An idle CLI records a message within a second or two; still missing after a few, it is
      // being held (e.g. a long paste waiting for another Enter): offer to send it.
      setTimeout(
        () => setPending((prev) => prev.map((p) => (p.id === pendingId ? { ...p, due: true } : p))),
        4_000,
      );
    } catch {
      // Shown by onError. Nothing typed is lost: the message goes back into the box.
      setPending((prev) => prev.filter((p) => p.id !== pendingId));
      setDraft(text);
      setAttachments(images);
    } finally {
      setSending(false);
    }
  };

  // The keys act as they do in the terminal (PM-116). With the CLI asking something, they go
  // to it (moving through its menu, confirming). Otherwise ↑ / ↓ step through your earlier
  // messages into the box, like a CLI's input history, and ⏎ sends the box (or presses Enter
  // in the CLI when the box is empty).
  const [sent, setSent] = useState<string[]>([]);
  /** Messages you sent that the transcript doesn't show yet (the CLI may still be busy). */
  const [pending, setPending] = useState<
    { id: number; text: string; label: string; due: boolean }[]
  >([]);
  const pendingSeq = useRef(0);
  // A pending message is done once the transcript has it as a user message.
  const recorded = new Set(
    items.filter((i) => i.kind === 'user' && i.text).map((i) => i.text!.trim()),
  );
  const unrecorded = pending.filter((p) => !recorded.has(p.text));
  /** Which earlier message ↑ / ↓ is showing (from the newest back), and the draft it replaced. */
  const [recall, setRecall] = useState<{ index: number; draft: string } | null>(null);
  const history = () => {
    const fromTranscript = items
      .filter((i) => i.kind === 'user' && i.text)
      .map((i) => i.text!.trim());
    const all = [...fromTranscript, ...sent.filter((t) => !fromTranscript.includes(t))];
    // Newest first, without repeats of the same message in a row.
    return all.reverse().filter((t, i, list) => t && t !== list[i - 1]);
  };
  const fill = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const box = composer.current;
      if (!box) return;
      box.style.height = 'auto';
      box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
      box.setSelectionRange(text.length, text.length);
    });
  };
  const recallMessage = (step: 1 | -1) => {
    const list = history();
    const current = recall?.index ?? -1;
    const index = Math.min(list.length - 1, current + step);
    if (index < 0) {
      if (recall) fill(recall.draft); // Back past the newest: what you were typing.
      setRecall(null);
      return;
    }
    if (index === current) return;
    setRecall({ index, draft: recall?.draft ?? draft });
    fill(list[index]!);
  };
  const pressKey = (key: (typeof KEYS)[number]) => {
    if (!asking && (key.aria === 'Arrow up' || key.aria === 'Arrow down'))
      return recallMessage(key.aria === 'Arrow up' ? 1 : -1);
    if (!asking && key.aria === 'Enter' && (draft.trim() || attachments.length))
      return void submit();
    void send(key.data).catch(() => undefined);
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
        {unrecorded.map((p) => (
          <div key={p.id} className="chat-msg is-user is-pending">
            <div className="chat-bubble">{renderText(p.label)}</div>
            {working || asking ? (
              // The CLI holds messages while it works (or asks something) and sends them after.
              <span className="chat-pending-note">
                {asking ? 'Waiting: answer the CLI first' : 'Queued, sends when the CLI is done'}
              </span>
            ) : p.due ? (
              <span className="chat-pending-note">
                Not sent yet{' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => void send('\r').catch(() => undefined)}
                >
                  Send
                </button>
              </span>
            ) : (
              <span className="chat-pending-note">Sending…</span>
            )}
          </div>
        ))}
        {working && (
          <div className="chat-working" role="status">
            <span className="chat-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="chat-status-line">{status ?? 'Working…'}</span>
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
            onClick={() => pressKey(k)}
          >
            {k.label}
          </button>
        ))}
      </div>
      {(attachments.length > 0 || uploading > 0) && (
        <div className="chat-attachments" aria-label="Images to send">
          {attachments.map((a) => (
            <span key={a.path} className="chat-attachment" title={a.name}>
              {a.preview ? <img src={a.preview} alt={a.name} /> : <span>{a.name}</span>}
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => removeAttachment(a.path)}
              >
                ×
              </button>
            </span>
          ))}
          {uploading > 0 && (
            <span className="chat-attachment is-uploading" role="status">
              <span className="spinner" aria-hidden="true" /> Adding…
            </span>
          )}
        </div>
      )}
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onDragOver={(e) => {
          if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/')))
            e.preventDefault();
        }}
        onDrop={(e) => {
          const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
          if (!files.length) return;
          e.preventDefault();
          void addImages(files);
        }}
      >
        <button
          type="button"
          className="chat-attach"
          aria-label="Add images"
          title="Add images (or paste / drop them into the message)"
          onClick={() => picker.current?.click()}
        >
          <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
            <rect
              x="2"
              y="3"
              width="12"
              height="10"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <circle cx="6" cy="6.5" r="1.2" fill="currentColor" />
            <path
              d="M3 12l3.5-3.5 2.5 2.5 1.5-1.5L14 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
          </svg>
        </button>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void addImages([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <textarea
          ref={composer}
          className="input chat-input"
          value={draft}
          rows={1}
          enterKeyHint="send"
          placeholder={
            session.status === 'running' ? 'Message…' : 'Session is down: queues for relaunch'
          }
          aria-label="Message to the session"
          onChange={(e) => {
            setDraft(e.target.value);
            setRecall(null); // Editing a recalled message makes it your draft.
            // Grow with the text, up to about six lines.
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
            if (!files.length) return; // Text pastes as usual.
            e.preventDefault();
            void addImages(files);
          }}
          onKeyDown={(e) => {
            // As in the CLI: Return sends, Shift+Return adds a line. Never mid-composition
            // (IME input such as Vietnamese or emoji pickers use Return to confirm a word).
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
              return;
            }
            // Physical keyboards: ↑ on the first line / ↓ on the last recall messages, as in a CLI.
            const box = e.currentTarget;
            const before = box.value.slice(0, box.selectionStart);
            const after = box.value.slice(box.selectionEnd);
            if (e.key === 'ArrowUp' && !before.includes('\n') && !e.shiftKey) {
              e.preventDefault();
              recallMessage(1);
            } else if (e.key === 'ArrowDown' && !after.includes('\n') && recall && !e.shiftKey) {
              e.preventDefault();
              recallMessage(-1);
            }
          }}
        />
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
    if (view === 'terminal' && preferred === 'chat' && session) handOffDraft(session.id);
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
