import {
  createContext,
  memo,
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import type { AgentSession, ChatItem, SlashCommand } from '../../../shared/types';
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

/**
 * Empties the CLI's whole input before a message goes in (PM-125). Text can already be there,
 * often over several lines: messages Claude puts back after an Esc while busy, a draft handed
 * to the terminal view, typing in the terminal. Ctrl+U alone cleared only the last line, so
 * the rest went out in front of the new message. Per line: Ctrl+E (end), Ctrl+U (delete it),
 * Backspace (into the line above); all harmless on an empty input, and nothing here can
 * interrupt a running agent (unlike Ctrl+C).
 */
export const CLEAR_INPUT = '\x05\x15\x7f'.repeat(12) + '\x05\x15';

const KEYS: { label: string; aria: string; data: string }[] = [
  { label: 'Esc', aria: 'Escape', data: '\x1b' },
  { label: '↑', aria: 'Arrow up', data: '\x1b[A' },
  { label: '↓', aria: 'Arrow down', data: '\x1b[B' },
  { label: '⏎', aria: 'Enter', data: '\r' },
  { label: '1', aria: '1', data: '1' },
  { label: '2', aria: '2', data: '2' },
  { label: '3', aria: '3', data: '3' },
  { label: '^C', aria: 'Interrupt (Control C)', data: '\x03' },
  // Cycles the permission mode (auto / plan / accept edits), as Shift+Tab does in the CLI.
  { label: '⇧Tab', aria: 'Shift+Tab (cycle mode)', data: '\x1b[Z' },
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
/** A safe external link: http(s) only, opened in a new tab without access to this page. */
const link = (href: string, label: ReactNode, key: string | number) =>
  /^https?:\/\//i.test(href) ? (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  ) : (
    label
  );

function inline(text: string, key: string): ReactNode {
  // `code`, **bold**, [label](url) and bare http(s) URLs; everything else stays text.
  const parts = text.split(
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>)]+)/,
  );
  return (
    <span key={key}>
      {parts.map((part, j) => {
        if (part.startsWith('`') && part.endsWith('`') && part.length > 1)
          return <code key={j}>{part.slice(1, -1)}</code>;
        if (part.startsWith('**') && part.endsWith('**') && part.length > 3)
          return <strong key={j}>{part.slice(2, -2)}</strong>;
        const md = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
        if (md) return link(md[2]!, md[1], j);
        if (/^https?:\/\//i.test(part)) {
          const url = part.replace(/[.,;:!?]+$/, ''); // Sentence punctuation isn't part of it.
          return (
            <span key={j}>
              {link(url, url, 'a')}
              {part.slice(url.length)}
            </span>
          );
        }
        return part;
      })}
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
    // A divider: ---, *** or ___ alone on a line.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push(<hr key={`${key}-r${i}`} className="chat-rule" />);
      continue;
    }
    // A list: consecutive "- item" / "* item" / "1. item" lines (indented ones nest visually).
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    if (item.test(line)) {
      flush();
      const ordered = /\d/.test(item.exec(line)![2]!);
      const entries: { depth: number; text: string }[] = [];
      // One list per marker kind: bullets and numbers that follow each other are two lists.
      const sameKind = (l: string) => {
        const m = item.exec(l);
        return !!m && /\d/.test(m[2]!) === ordered;
      };
      while (i < lines.length && sameKind(lines[i]!)) {
        const m = item.exec(lines[i++]!)!;
        entries.push({ depth: Math.min(3, Math.floor(m[1]!.length / 2)), text: m[3]! });
      }
      i--;
      const List = ordered ? 'ol' : 'ul';
      out.push(
        <List key={`${key}-l${i}`} className="chat-list-block">
          {entries.map((e, n) => (
            <li key={n} style={e.depth ? { marginLeft: `${e.depth * 1.1}em` } : undefined}>
              {inline(e.text, `li${n}`)}
            </li>
          ))}
        </List>,
      );
      continue;
    }
    // A quote: consecutive "> " lines.
    if (/^\s*>\s?/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!))
        quoted.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      i--;
      out.push(
        <blockquote key={`${key}-q${i}`} className="chat-quote">
          {inline(quoted.join('\n'), 'q')}
        </blockquote>,
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
  // A marker (interrupted, compacted): a small centred line; a compaction keeps its summary.
  if (item.kind === 'note')
    return item.input ? (
      <details className="chat-note">
        <summary>{item.text} · summary</summary>
        <div className="chat-note-detail">{renderText(item.input)}</div>
      </details>
    ) : (
      <div className="chat-note">{item.text}</div>
    );
  return (
    <div className={`chat-msg is-${item.kind}`}>
      <div className="chat-bubble">{renderText(item.text ?? '')}</div>
    </div>
  );
});

interface DiffLine {
  kind: 'add' | 'del' | 'same' | 'file';
  text: string;
}
const DIFF_LINES = 400;
/**
 * A file edit as a diff, like the CLIs show it (PM-123): Claude's Edit / MultiEdit / Write
 * inputs and Codex's apply_patch. Null for other tools, or an input cut short.
 */
export function editDiff(name: string | undefined, input: string | undefined): DiffLine[] | null {
  if (!input) return null;
  const lines = (text: string, kind: DiffLine['kind']) =>
    text.split('\n').map((t) => ({ kind, text: t }));
  let out: DiffLine[] | null = null;
  if (name === 'apply_patch' || input.startsWith('*** Begin Patch')) {
    out = input
      .split('\n')
      .filter((t) => !/^\*\*\* (Begin|End) Patch/.test(t))
      .map((t) =>
        t.startsWith('*** ') || t.startsWith('@@')
          ? { kind: 'file' as const, text: t.replace(/^\*\*\* /, '') }
          : t.startsWith('+')
            ? { kind: 'add' as const, text: t.slice(1) }
            : t.startsWith('-')
              ? { kind: 'del' as const, text: t.slice(1) }
              : { kind: 'same' as const, text: t.replace(/^ /, '') },
      );
  } else if (name === 'Edit' || name === 'MultiEdit' || name === 'Write') {
    try {
      const o = JSON.parse(input) as {
        file_path?: string;
        old_string?: string;
        new_string?: string;
        content?: string;
        edits?: { old_string?: string; new_string?: string }[];
      };
      const edits =
        name === 'Write'
          ? [{ old_string: '', new_string: o.content ?? '' }]
          : (o.edits ?? [{ old_string: o.old_string, new_string: o.new_string }]);
      out = [{ kind: 'file', text: o.file_path ?? '' }];
      for (const e of edits) {
        if (e.old_string) out.push(...lines(e.old_string, 'del'));
        if (e.new_string) out.push(...lines(e.new_string, 'add'));
      }
    } catch {
      return null;
    }
  }
  if (!out) return null;
  return out.length > DIFF_LINES
    ? [
        ...out.slice(0, DIFF_LINES),
        { kind: 'file', text: `… ${out.length - DIFF_LINES} more lines` },
      ]
    : out;
}

/** The session a chat shows, for parts that load more of it (a subagent's steps). */
const SessionIdContext = createContext<number | null>(null);

/**
 * A Claude subagent's own steps and messages (PM-123), loaded when asked for: the parent
 * transcript only records the prompt and the final report.
 */
function SubagentSteps({ toolId }: { toolId: string }) {
  const sessionId = useContext(SessionIdContext);
  const [items, setItems] = useState<ChatItem[] | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  if (sessionId === null) return null;
  const load = () => {
    setLoading(true);
    api
      .sessionSubagent(sessionId, toolId)
      .then((r) => setItems(r.items))
      .catch(() => setItems(null))
      .finally(() => setLoading(false));
  };
  if (items === undefined)
    return (
      <button type="button" className="btn chat-subagent-load" onClick={load} disabled={loading}>
        {loading ? 'Loading…' : 'Show its steps'}
      </button>
    );
  if (!items?.length) return <p className="faint chat-subagent-none">No steps recorded.</p>;
  return (
    <div className="chat-subagent">
      {merge(items).map((e) =>
        e.item.kind === 'tool' ? (
          <ToolCall key={e.item.id} entry={e} />
        ) : (
          <div key={e.item.id} className={`chat-subagent-text is-${e.item.kind}`}>
            {renderText(e.item.text ?? '')}
          </div>
        ),
      )}
    </div>
  );
}

const ToolCall = memo(function ToolCall({ entry }: { entry: Entry }) {
  const { item, result } = entry;
  const state = !result ? 'running' : result.isError ? 'error' : 'done';
  const diff = editDiff(item.name, item.input);
  const subagent = (item.name === 'Agent' || item.name === 'Task') && item.toolId;
  return (
    <details className={`chat-tool is-${state}`}>
      <summary>
        <span className="chat-tool-state" aria-label={state} />
        <span className="chat-tool-name">{item.name}</span>
        <span className="chat-tool-summary">{item.summary}</span>
      </summary>
      {diff ? (
        <>
          <div className="chat-tool-label">Changes</div>
          <pre className="chat-code chat-diff">
            {diff.map((l, i) => (
              <span key={i} className={`is-${l.kind}`}>
                {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : l.kind === 'same' ? '  ' : ''}
                {l.text}
                {'\n'}
              </span>
            ))}
          </pre>
        </>
      ) : (
        item.input && (
          <>
            <div className="chat-tool-label">Input</div>
            <pre className="chat-code">{item.input}</pre>
          </>
        )
      )}
      {subagent && (
        <>
          <div className="chat-tool-label">Steps</div>
          <SubagentSteps toolId={subagent} />
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

/**
 * Tool calls that speak to you rather than do work (PM-123): a question with options, or the
 * agent's plan / to-do list. They show as their own cards, never folded into "N steps".
 */
const SPEAKING_TOOLS = new Set(['AskUserQuestion', 'TodoWrite', 'update_plan', 'ExitPlanMode']);

/** The plan Claude asks you to approve when leaving plan mode (ExitPlanMode's input). */
export function proposedPlan(input: string | undefined): string | null {
  try {
    const plan = (JSON.parse(input ?? '') as { plan?: unknown }).plan;
    return typeof plan === 'string' && plan.trim() ? plan : null;
  } catch {
    return null;
  }
}

interface PlanStep {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}
/** A to-do / plan tool's steps (Claude TodoWrite: todos[]; Codex update_plan: plan[]). */
export function planSteps(input: string | undefined): PlanStep[] | null {
  try {
    const o = JSON.parse(input ?? '') as {
      todos?: { content?: string; activeForm?: string; status?: string }[];
      plan?: { step?: string; status?: string }[];
    };
    const list = o.todos ?? o.plan;
    if (!Array.isArray(list)) return null;
    return list.map((s) => {
      const status = String(s.status ?? 'pending');
      const text =
        ('content' in s ? (status === 'in_progress' && s.activeForm) || s.content : undefined) ??
        ('step' in s ? s.step : undefined) ??
        '';
      return {
        text: String(text),
        status: status === 'completed' || status === 'in_progress' ? status : 'pending',
      };
    });
  } catch {
    return null;
  }
}

interface Question {
  question: string;
  options: { label: string; description?: string }[];
}
/** AskUserQuestion's questions and their options. */
export function questions(input: string | undefined): Question[] | null {
  try {
    const o = JSON.parse(input ?? '') as {
      questions?: { question?: string; options?: { label?: string; description?: string }[] }[];
    };
    if (!Array.isArray(o.questions)) return null;
    return o.questions.map((q) => ({
      question: String(q.question ?? ''),
      options: (q.options ?? []).map((op) => ({
        label: String(op.label ?? ''),
        description: op.description,
      })),
    }));
  } catch {
    return null;
  }
}

const SpeakingTool = memo(function SpeakingTool({ entry }: { entry: Entry }) {
  const { item, result } = entry;
  if (item.name === 'AskUserQuestion') {
    const asked = questions(item.input);
    if (!asked) return <ToolCall entry={entry} />;
    return (
      <div className="chat-card chat-question">
        {asked.map((q, i) => (
          <div key={i}>
            <div className="chat-card-title">{q.question}</div>
            <ol className="chat-question-options">
              {q.options.map((op, j) => (
                <li key={j}>
                  <span className="chat-question-label">{op.label}</span>
                  {op.description && <span className="faint"> · {op.description}</span>}
                </li>
              ))}
            </ol>
          </div>
        ))}
        {result?.text && (
          <div className="chat-question-answer">Answered: {result.text.slice(0, 300)}</div>
        )}
      </div>
    );
  }
  if (item.name === 'ExitPlanMode') {
    const plan = proposedPlan(item.input);
    if (!plan) return <ToolCall entry={entry} />;
    return (
      <div className="chat-card chat-proposed-plan">
        <div className="chat-card-title">
          Plan ·{' '}
          {!result ? 'waiting for your approval' : result.isError ? 'not approved' : 'approved'}
        </div>
        <div className="chat-proposed-plan-body">{renderText(plan)}</div>
      </div>
    );
  }
  const steps = planSteps(item.input);
  if (!steps) return <ToolCall entry={entry} />;
  const done = steps.filter((s) => s.status === 'completed').length;
  return (
    <div className="chat-card chat-plan">
      <div className="chat-card-title">
        Plan · {done}/{steps.length} done
      </div>
      <ul className="chat-plan-steps">
        {steps.map((s, i) => (
          <li key={i} className={`is-${s.status}`}>
            <span className="chat-plan-mark" aria-label={s.status.replace('_', ' ')}>
              {s.status === 'completed' ? '☑' : s.status === 'in_progress' ? '◐' : '☐'}
            </span>
            {s.text}
          </li>
        ))}
      </ul>
    </div>
  );
});

function blocks(entries: Entry[]): Block[] {
  const out: Block[] = [];
  for (const entry of entries) {
    const last = out.at(-1);
    if (entry.item.kind !== 'tool' || SPEAKING_TOOLS.has(entry.item.name ?? ''))
      out.push({ kind: 'message', entry });
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
  return screenInfo(screen).status;
}

/** What the CLI shows around its input that the transcript doesn't record (PM-122). */
export interface ScreenInfo {
  /** Its status line: "Finagling… (7m 49s · ↓ 7.8k tokens)", "Waiting for 2 background agents". */
  status: string | null;
  /** Its permission mode, when not the default: "auto mode on", "plan mode on". */
  mode: string | null;
  /** Background agents and shells it runs: "general-purpose · 6m 16s · ↓ 113.8k". */
  background: string[];
  /** Claude Code's goal line: "/goal active (26m)". */
  goal: string | null;
}

/** Which mode it is, for its colour as in the CLI (PM-134). */
export function modeKind(mode: string): 'auto' | 'plan' | 'accept' | 'bypass' | 'other' {
  return /auto/i.test(mode)
    ? 'auto'
    : /plan/i.test(mode)
      ? 'plan'
      : /accept/i.test(mode)
        ? 'accept'
        : /bypass/i.test(mode)
          ? 'bypass'
          : 'other';
}

/**
 * The status line split the way the CLI draws it (PM-134): the activity ("Finagling…", in the
 * CLI's accent) and its details in brackets ("(7m 49s · ↓ 7.8k tokens)", muted). Special
 * characters (…, ·, ↓) are kept as they are.
 */
export function statusParts(status: string): { activity: string; details: string } {
  const at = status.indexOf(' (');
  return at > 0
    ? { activity: status.slice(0, at), details: status.slice(at + 1) }
    : { activity: status, details: '' };
}

const SPINNER = /^[✻✶✢✽✳✺✹✸✷*·•◦⋆✦]\s*(?=\p{L})/u;
const clean = (s: string) =>
  s
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s*[·•]\s*esc\s*to\s*interrupt/i, '')
    .replace(/\s*\(?shift\s*\+\s*tab[^)]*\)?/i, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Reads the CLI's screen (plain text, see sessionScreen) for the chat view: the status line, the
 * permission mode and the background agents, all things the terminal shows live but the
 * transcript never records. Lines wrapped by the terminal are joined back.
 */
export function screenInfo(screen: string): ScreenInfo {
  const raw = screen.split('\n');
  const info: ScreenInfo = { status: null, mode: null, background: [], goal: null };
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!.trim();
    if (!line) continue;
    // A wrapped line continues on indented lines that start no new item.
    const continued = () => {
      let text = line;
      while (
        i + 1 < raw.length &&
        /^\s{2,}\S/.test(raw[i + 1]!) &&
        !SPINNER.test(raw[i + 1]!.trim()) &&
        !/^[─━>›❯(]/.test(raw[i + 1]!.trim())
      )
        text += ` ${raw[++i]!.trim()}`;
      return text;
    };
    // Claude Code's goal line, on a line of its own (often after the input box's rule):
    // "◎ /goal active (26m)".
    const goal = /◎\s*(\/goal\b[^─━│]*?)\s*[─━│]*$/.exec(line);
    if (goal) {
      info.goal = goal[1]!.replace(/\s+/g, ' ').trim();
      continue;
    }
    const mode = /\b(auto mode|plan mode|accept edits|bypass permissions)\b[^(·]*\bon\b/i.exec(
      line,
    );
    if (mode) {
      info.mode = clean(mode[0]!);
      continue;
    }
    // Background agents / shells: a status bullet, a name, then time and tokens.
    if (/^(\(\s*\)|[◯○◉●◐◓◑◒])\s+\S/.test(line) && /\d+[smh]\b|↓/.test(line)) {
      info.background.push(
        clean(line.replace(/^\(\s*\)\s*/, ''))
          .replace(/\s+t?(\d+[hms]\b)/, ' · $1')
          .replace(/\s*·\s*·\s*/g, ' · '),
      );
      continue;
    }
    // The status line: a spinner glyph with an ellipsis, a timer or "waiting for" (a bare
    // bullet is just output, e.g. Codex's "• Ran npm test"), or Codex's "Working (…)".
    if (
      (SPINNER.test(line) && /…|\(\s*\d+[smh]|waiting for/i.test(line)) ||
      /^[•◦]?\s*working\s*\(\s*\d+[smh]/i.test(line)
    )
      info.status = clean(continued());
  }
  return info;
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
    .sendSessionInput(sessionId, CLEAR_INPUT)
    .then(() => api.sendSessionInput(sessionId, `\x1b[200~${text}\x1b[201~`))
    .catch(() => undefined);
}

/** A composer suggestion: a slash command or a file, and the draft that picking it gives. */
interface Suggestion {
  value: string;
  label: string;
  detail?: string;
  insert: string;
}

/** Commands matching what follows "/": name starts with it, then contains it, then described. */
export function rankCommands(commands: SlashCommand[], query: string, limit = 8): SlashCommand[] {
  const q = query.toLowerCase();
  const score = (c: SlashCommand) => {
    const name = c.name.toLowerCase();
    return name.startsWith(q)
      ? 0
      : name.includes(q)
        ? 1
        : q.length >= 3 && c.description.toLowerCase().includes(q) // 1-2 letters: names only.
          ? 2
          : -1;
  };
  return commands
    .map((c, i) => ({ c, s: score(c), i }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}

/**
 * Image files on a paste or drop (PM-130): from `files`, or from `items` when that's all there
 * is (iPhone Safari often puts a pasted image only in `items`).
 */
export function droppedFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = [...data.files];
  if (files.length) return files;
  return [...data.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((f): f is File => !!f);
}

/** An image by its type, or by its name when the type is missing (iOS sometimes sends none). */
export const isImageFile = (f: File) =>
  f.type.startsWith('image/') || (!f.type && /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(f.name));

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
  // Also while idle (PM-122): background agents, the mode and "waiting for…" show then too.
  // Read every 1.5 s while it works or asks, every 4 s otherwise; never for a stopped session.
  const live = session.status === 'running';
  useEffect(() => {
    if (!live) return;
    let active = true;
    const stop = serialPoll(
      () =>
        api.sessionScreen(id).then((s) => {
          if (active) setScreen(s.text);
        }),
      asking || working ? POLL_MS : 4_000,
    );
    return () => {
      active = false;
      stop();
    };
  }, [id, live, asking, working]);
  const shown: ScreenInfo = live
    ? screenInfo(screen)
    : { status: null, mode: null, background: [], goal: null };
  const status = shown.status;

  // Follow new messages while at the bottom; otherwise count them on a "new messages" pill.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && atBottom.current) list.scrollTop = list.scrollHeight;
  }, [items, screen, working]);
  // Scrolled up: a button brings you back to the latest message (with how many are new).
  const [scrolledUp, setScrolledUp] = useState(false);
  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    atBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    setScrolledUp(list.scrollHeight - list.scrollTop - list.clientHeight > 240);
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
  // The box fits its text whenever the text changes, however it changed (PM-128): typing, a
  // draft carried over from the terminal view, a recalled message, cleared after sending. One
  // line when empty, up to about six, then it scrolls.
  useLayoutEffect(() => {
    const box = composer.current;
    if (!box) return;
    box.style.height = '';
    if (draft) box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
  }, [draft]);

  // Images (PM-116): pasted, dropped or picked into the composer, uploaded at once, and sent
  // with the message as their paths, which Claude Code and Codex attach as images.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  /** Why the last image couldn't be added, shown beside the composer (PM-130). */
  const [imageError, setImageError] = useState('');
  const addImages = async (files: File[]) => {
    const images = files.filter(isImageFile);
    if (files.length && !images.length) setImageError('That file is not an image.');
    if (!images.length) return;
    setImageError('');
    setUploading((n) => n + images.length);
    for (const file of images) {
      try {
        const { path } = await api.uploadSessionImage(id, await prepareImage(file));
        const name = file.name || 'image';
        setAttachments((prev) => [...prev, { path, name, preview: URL.createObjectURL(file) }]);
      } catch (e) {
        // Shown here, by the composer: the page's error banner is off-screen in the dock and
        // in full screen, so a failure looked like nothing happened.
        setImageError(`Couldn't add ${file.name || 'the image'}: ${(e as Error).message}`);
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

  /**
   * Sends the box (text and images), or `quick`, a fixed message such as "continue" (PM-121)
   * that leaves whatever you're typing in the box alone.
   */
  const submit = async (quick?: string) => {
    const text = quick ?? draft.trim();
    const images = quick ? [] : attachments;
    if ((!text && !images.length) || sending || (!quick && uploading)) return;
    setSending(true);
    // Shown in the chat at once (PM-116), until the CLI's transcript records it.
    const pendingId = ++pendingSeq.current;
    const shown = [...images.map((a) => `[image: ${a.name}]`), text].filter(Boolean).join('\n');
    setPending((prev) => [
      ...prev,
      { id: pendingId, text: text || shown, label: shown, due: false },
    ]);
    if (!quick) {
      setDraft('');
      setAttachments([]);
      setRecall(null);
    }
    atBottom.current = true;
    try {
      // Only what you typed: first empty the CLI's whole input (CLEAR_INPUT: leftovers there
      // went out in front of the message, PM-125). Each image path
      // goes in as its own paste (that's how the CLIs recognise an image), then the text as
      // one bracketed paste (multi-line stays one prompt), and Enter submits it.
      await send(CLEAR_INPUT);
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
      if (!quick) {
        setDraft(text);
        setAttachments(images);
      }
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
  /**
   * Your messages, newest first, as a CLI's ↑ walks them (PM-118): what you just sent that the
   * transcript doesn't show yet, then the transcript's, newest to oldest. A message you send
   * again counts at its newest place, not where it first appeared.
   */
  const history = () => {
    const fromTranscript = items
      .filter((i) => i.kind === 'user' && i.text)
      .map((i) => i.text!.trim());
    const newestFirst = [
      ...unrecorded.map((p) => p.text).reverse(),
      ...[...sent].reverse().filter((t) => !fromTranscript.includes(t)),
      ...fromTranscript.reverse(),
    ];
    const seen = new Set<string>();
    return newestFirst.filter((t) => t && !seen.has(t) && (seen.add(t), true));
  };
  const fill = (text: string) => {
    setDraft(text);
    requestAnimationFrame(() => {
      const box = composer.current;
      if (!box) return;
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
  // Suggestions (PM-117), as the CLIs offer them: "/" at the start lists slash commands
  // (built in, custom, skills) and "@" a project file. ↑ / ↓ move, ⏎ or Tab picks, Esc closes.
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  useEffect(() => {
    let active = true;
    api.sessionCommands(id).then(
      (list) => active && setCommands(list),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [id]);
  const slash = /^\/(\S*)$/.exec(draft)?.[1];
  const mention = /(?:^|\s)@(\S*)$/.exec(draft)?.[1];
  const [files, setFiles] = useState<{ q: string; list: string[] }>({ q: '', list: [] });
  useEffect(() => {
    if (mention === undefined) return;
    let active = true;
    const timer = setTimeout(
      () =>
        api.sessionFiles(id, mention).then(
          (list) => active && setFiles({ q: mention, list }),
          () => undefined,
        ),
      150,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id, mention]);
  /** The draft at which Esc closed the list: it stays closed until you type on. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [selectedRaw, setSelected] = useState(0);
  const suggestions: Suggestion[] =
    dismissed === draft
      ? []
      : slash !== undefined
        ? rankCommands(commands, slash).map((c) => ({
            value: `/${c.name}`,
            label: `/${c.name}`,
            detail: c.description,
            insert: `/${c.name} `,
          }))
        : mention !== undefined && files.q === mention
          ? files.list.map((f) => ({
              value: f,
              label: f.slice(f.lastIndexOf('/') + 1),
              detail: f,
              insert: draft.replace(/@\S*$/, `@${f} `),
            }))
          : [];
  const selected = Math.min(selectedRaw, Math.max(0, suggestions.length - 1));
  const applySuggestion = (s: Suggestion) => {
    fill(s.insert);
    setSelected(0);
    composer.current?.focus();
  };
  /** Handles a key while the list is open; true when it did. */
  const suggestionKey = (key: 'up' | 'down' | 'pick' | 'close'): boolean => {
    if (!suggestions.length) return false;
    if (key === 'up') setSelected((selected - 1 + suggestions.length) % suggestions.length);
    else if (key === 'down') setSelected((selected + 1) % suggestions.length);
    else if (key === 'pick') applySuggestion(suggestions[selected]!);
    else setDismissed(draft);
    return true;
  };

  const pressKey = (key: (typeof KEYS)[number]) => {
    const listKey =
      key.aria === 'Arrow up'
        ? 'up'
        : key.aria === 'Arrow down'
          ? 'down'
          : key.aria === 'Enter'
            ? 'pick'
            : key.aria === 'Escape'
              ? 'close'
              : null;
    if (listKey && suggestionKey(listKey)) return;
    if (!asking && (key.aria === 'Arrow up' || key.aria === 'Arrow down'))
      return recallMessage(key.aria === 'Arrow up' ? 1 : -1);
    if (!asking && key.aria === 'Enter' && (draft.trim() || attachments.length))
      return void submit();
    void send(key.data).catch(() => undefined);
  };

  const entries = merge(items);
  return (
    <SessionIdContext.Provider value={session.id}>
      <div className="session-chat">
        <div className="chat-list" ref={listRef} onScroll={onScroll} aria-live="polite">
          {!loaded ? (
            // Message-shaped placeholders while the transcript loads (PM-127).
            <div className="chat-loading" role="status" aria-label="Loading messages">
              {(['user', 'assistant', 'user', 'assistant'] as const).map((who, i) => (
                <div key={i} className={`chat-msg is-${who}`}>
                  <div className={`skeleton chat-loading-bubble is-${who}`} />
                </div>
              ))}
            </div>
          ) : !supported ? (
            <p className="chat-empty">
              This CLI has no readable transcript: use the terminal view.
            </p>
          ) : !entries.length ? (
            <p className="chat-empty">No messages yet. Send one below.</p>
          ) : (
            blocks(entries).map((b) =>
              b.kind === 'steps' ? (
                <Steps key={b.id} steps={b.steps} />
              ) : b.entry.item.kind === 'tool' ? (
                <SpeakingTool key={b.entry.item.id} entry={b.entry} />
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
          {/* What the terminal shows live around its input (PM-122): status, mode, background. */}
          {(working || status || shown.mode || shown.goal || shown.background.length > 0) && (
            <div className="chat-live" role="status" aria-label="Session status">
              {(working || status) && (
                <div className={working ? 'chat-working is-working' : 'chat-working'}>
                  {working && (
                    <span className="chat-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                  <span className="chat-status-line">
                    {status ? (
                      <>
                        <span className="chat-status-activity">{statusParts(status).activity}</span>
                        {statusParts(status).details && (
                          <span className="chat-status-details">
                            {' '}
                            {statusParts(status).details}
                          </span>
                        )}
                      </>
                    ) : (
                      'Working…'
                    )}
                  </span>
                </div>
              )}
              {shown.background.length > 0 && (
                <ul className="chat-background" aria-label="Running in the background">
                  {shown.background.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              )}
              {shown.goal && <span className="chat-goal">◎ {shown.goal}</span>}
              {shown.mode && (
                <span className={`chat-mode is-${modeKind(shown.mode)}`}>
                  {modeKind(shown.mode) === 'plan' ? '⏸' : '⏵⏵'} {shown.mode}
                </span>
              )}
            </div>
          )}
          {asking && (
            <div className="chat-asking" role="status">
              <div className="chat-tool-label">The CLI is asking:</div>
              <pre className="chat-code">{screen || 'Reading the screen…'}</pre>
            </div>
          )}
        </div>
        {(unseen > 0 || scrolledUp) && (
          <button
            type="button"
            className={`chat-new${unseen > 0 ? '' : ' is-plain'}`}
            aria-label="Jump to the latest message"
            onClick={jumpToLatest}
          >
            {unseen > 0 ? `${unseen} new message${unseen === 1 ? '' : 's'} ↓` : '↓'}
          </button>
        )}
        <div className="chat-keys" role="group" aria-label="Terminal keys">
          {/* First key (PM-121): Continue, the most common nudge. Enter is only needed while the
            CLI asks something or a suggestion list is open, and then takes this place. */}
          {asking || suggestions.length ? (
            <button
              key="enter"
              type="button"
              className="chat-key"
              aria-label="Enter"
              onClick={() => pressKey(KEYS.find((k) => k.aria === 'Enter')!)}
            >
              ⏎
            </button>
          ) : (
            <button
              key="continue"
              type="button"
              className="chat-key chat-key-continue"
              title='Send "continue"'
              onClick={() => void submit('continue')}
            >
              continue
            </button>
          )}
          {KEYS.filter((k) => k.aria !== 'Enter').map((k) => (
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
        {imageError && (
          <p className="chat-image-error" role="alert">
            {imageError}{' '}
            <button type="button" className="link-button" onClick={() => setImageError('')}>
              Dismiss
            </button>
          </p>
        )}
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
            if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault();
          }}
          onDrop={(e) => {
            const files = droppedFiles(e.dataTransfer).filter(isImageFile);
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
              setSelected(0);
            }}
            onPaste={(e) => {
              const files = droppedFiles(e.clipboardData).filter(isImageFile);
              if (!files.length) return; // Text pastes as usual.
              e.preventDefault();
              void addImages(files);
            }}
            onKeyDown={(e) => {
              const listKey: Record<string, 'up' | 'down' | 'pick' | 'close'> = {
                ArrowUp: 'up',
                ArrowDown: 'down',
                Enter: 'pick',
                Tab: 'pick',
                Escape: 'close',
              };
              if (
                listKey[e.key] &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                suggestionKey(listKey[e.key]!)
              ) {
                e.preventDefault();
                return;
              }
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
        {/* Below the message box, as the CLIs show their command list (PM-132). */}
        {suggestions.length > 0 && (
          <ul className="chat-suggest" role="listbox" aria-label="Suggestions">
            {suggestions.map((s, i) => (
              <li
                key={s.value}
                role="option"
                aria-selected={i === selected}
                className={i === selected ? 'is-selected' : undefined}
                // Pointer down (not click) so the message box keeps focus and the keyboard stays.
                onPointerDown={(e) => {
                  e.preventDefault();
                  applySuggestion(s);
                }}
              >
                <span className="chat-suggest-label">{s.label}</span>
                {s.detail && <span className="chat-suggest-detail">{s.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SessionIdContext.Provider>
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
