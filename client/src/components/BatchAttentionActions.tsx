import { useEffect, useId, useRef, useState } from 'react';
import type { AgentSession } from '../../../shared/types';
import { api } from '../api';
import { splitSessionInput } from '../lib/sessionInput';

export type AttentionCommand =
  | { kind: 'key'; data: string }
  | { kind: 'line'; text: string }
  /** Codex terminals at their usage limit (PM-58): opt in to continuing once at the reset. */
  | { kind: 'auto-continue' }
  /** Codex terminals at their usage limit: send the continuation now, into an empty prompt. */
  | { kind: 'continue-now' };

export interface AttentionOption {
  key: string;
  label: string;
  detail?: string;
  command: AttentionCommand;
}

export interface DetectedAttentionOverlay {
  title: string;
  options: AttentionOption[];
}

const CHOICE_HINT_RE =
  /enter\s*(?:to\s*)?(?:select|confirm|submit|continue)|↑\s*\/\s*↓|esc\s*(?:to\s*)?(?:back|cancel)|resume\s+paused\s+goal\?|what\s+do\s+you\s+want\s+to\s+do\?|\([○●]\)/i;

function normalizeChoiceKey(num: number, rawLabel: string): string {
  if (/^resume\s+goal\b/i.test(rawLabel)) return 'resume-goal';
  if (/^(?:leave\s+paused|pause\s+goal)\b/i.test(rawLabel)) return 'pause-goal';
  const slug = rawLabel
    .toLowerCase()
    .replace(/\s+at\s+.*$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `choice:${num}:${slug || num}`;
}

function parseNumberedLine(
  line: string,
  expectedNum: number,
): { label: string; detail?: string; hasCursor: boolean; column: number } | null {
  // Handle right-hand TUI overlays drawn over background text (e.g. "... visit h› 1. Resume goal   Mark it active ...").
  const cursorMatch = new RegExp(`[❯›>*▸►]\\s*${expectedNum}[.)]\\s+(\\S.*)$`).exec(line);
  let rest: string | null = null;
  let hasCursor = false;
  let column = 0;
  if (cursorMatch) {
    rest = cursorMatch[1]!;
    hasCursor = true;
    column = cursorMatch.index;
  } else {
    // A scrolling menu marks its first or last visible option with ↑ / ↓ (Claude Code).
    const plainMatch = new RegExp(
      `(?:^|\\s{2,})([❯›>*▸►]\\s*|[↑↓]\\s*)?${expectedNum}(?:[.)]|\\s*\\([○●]\\))\\s+(\\S.*)$`,
    ).exec(line);
    if (plainMatch) {
      hasCursor = Boolean(plainMatch[1]) && !/[↑↓]/.test(plainMatch[1]!);
      rest = plainMatch[2]!;
      column = line.length - plainMatch[0].trimStart().length;
    }
  }
  if (!rest) return null;
  // Strip trailing background column bleed separated by a wide gap (6+ spaces).
  const insideBox = rest.split(/\s{6,}/)[0]!.trim();
  if (!insideBox) return null;
  const parts = insideBox.split(/\s{2,}/);
  const label = parts[0]!.trim();
  const detail = parts.slice(1).join(' ').trim() || undefined;
  return { label, detail, hasCursor, column };
}

const BOX_CHARS_RE = /[▔─━│┃┌┐└┘├┤┬┴┼╭╮╰╯]+/g;

/**
 * The question a menu asks: the last sentence ending in "?" in the lines above it, not the
 * whole paragraph ("…would change live budgets. What do you want?" → "What do you want?").
 * A question wrapped onto two lines keeps its start from the line above.
 */
function extractOverlayTitle(lines: string[], firstChoiceIdx: number): string {
  for (let i = firstChoiceIdx - 1; i >= Math.max(0, firstChoiceIdx - 8); i--) {
    const raw = lines[i]!;
    if (/resume\s+paused\s+goal\?/i.test(raw)) return 'Resume paused goal?';
    if (/what\s+do\s+you\s+want\s+to\s+do\?/i.test(raw)) return 'What do you want to do?';
    const segments = raw
      .replace(BOX_CHARS_RE, ' ')
      .split(/\s{4,}/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (let s = segments.length - 1; s >= 0; s--) {
      const text = segments[s]!;
      const end = text.lastIndexOf('?');
      if (end < 0) continue;
      const upTo = text.slice(0, end + 1);
      const start = Math.max(upTo.lastIndexOf('. ', end - 1), upTo.lastIndexOf('! ', end - 1));
      let question = (start >= 0 ? upTo.slice(start + 2) : upTo).trim();
      // Started on the line above: take that line's last unfinished sentence too.
      if (start < 0 && s === 0 && i > 0) {
        const above = lines[i - 1]!.replace(BOX_CHARS_RE, ' ').trim();
        const cut = Math.max(
          above.lastIndexOf('. '),
          above.lastIndexOf('? '),
          above.lastIndexOf('! '),
        );
        const tail = (cut >= 0 ? above.slice(cut + 2) : above).trim();
        if (tail && !/[.?!:]$/.test(tail) && tail.length + question.length <= 160)
          question = `${tail} ${question}`;
      }
      if (question.length >= 3)
        return question.length > 160 ? `…${question.slice(-159)}` : question;
    }
  }
  return 'CLI choice overlay';
}

/** How far the numbering may skip (options scrolled out of a menu's visible window). */
const MAX_NUMBER_GAP = 2;

/** Codex terminals at their usage limit (PM-58): the batch choices it offers there. */
function usageLimitOptions(): AttentionOption[] {
  return [
    {
      key: 'limit:auto-continue',
      label: 'Auto-continue when the limit resets',
      detail: 'Continue once after the reset; typing in the terminal cancels it',
      command: { kind: 'auto-continue' },
    },
    {
      key: 'limit:try-again',
      label: 'Try again now',
      detail: 'Send the continuation once, only into an empty prompt',
      command: { kind: 'continue-now' },
    },
  ];
}

/**
 * Inspects a session's terminal screen for active CLI overlays (numbered selection menus such as
 * Codex's "Resume paused goal?", Claude Code's "What do you want to do?" usage-limit menu, tool
 * approval prompts, [y/n] questions, or paused-goal footers) and returns structured batch options.
 */
export function detectAttentionOverlay(
  screen: string,
  session?: Pick<AgentSession, 'providerId' | 'terminal' | 'usageLimit'>,
): DetectedAttentionOverlay | null {
  if (!screen.trim()) return null;
  const lines = screen.split(/\r?\n/);
  // Long menus (an option per line plus a description line each) need more than one screenful.
  const tailLines = lines.slice(-40);

  let firstChoiceIdx = -1;
  let firstChoiceHasCursor = false;
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const parsed = parseNumberedLine(tailLines[i]!, 1);
    if (parsed) {
      firstChoiceIdx = i;
      firstChoiceHasCursor = parsed.hasCursor;
      break;
    }
  }
  // Scrolled past option 1: the menu's first visible option is marked "↑ 3. …".
  let startNum = 1;
  if (firstChoiceIdx < 0) {
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const scrolled = /(?:^|\s{2,})↑\s*(\d{1,2})[.)]\s+\S/.exec(tailLines[i]!);
      if (scrolled) {
        firstChoiceIdx = i;
        startNum = Number(scrolled[1]);
        break;
      }
    }
  }

  const options: AttentionOption[] = [];
  let title = '';

  if (firstChoiceIdx >= 0) {
    const parsedChoices: {
      num: number;
      label: string;
      detail?: string;
      hasCursor: boolean;
      column: number;
      line: number;
    }[] = [];
    let nextNum = startNum;
    for (let i = firstChoiceIdx; i < tailLines.length && nextNum <= 19; i++) {
      // Options scrolled out of view leave gaps ("↓ 4. Keep 10", then "6. Chat about this").
      for (let num = nextNum; num <= nextNum + (nextNum === startNum ? 0 : MAX_NUMBER_GAP); num++) {
        const parsed = parseNumberedLine(tailLines[i]!, num);
        if (parsed) {
          parsedChoices.push({ num, ...parsed, line: i });
          nextNum = num + 1;
          break;
        }
      }
    }
    // A description on its own indented line under an option (Claude Code's menus) is its detail.
    for (const choice of parsedChoices) {
      if (choice.detail || choice.column > 12) continue;
      const below = tailLines[choice.line + 1];
      if (!below || parsedChoices.some((c) => c.line === choice.line + 1)) continue;
      const indent = below.length - below.trimStart().length;
      const text = below.replace(BOX_CHARS_RE, ' ').trim();
      if (text && indent > choice.column && !CHOICE_HINT_RE.test(text))
        choice.detail = text.length > 160 ? `${text.slice(0, 159)}…` : text;
    }
    const afterText = tailLines.slice(Math.max(0, firstChoiceIdx - 3)).join('\n');
    const isMenu =
      parsedChoices.length >= 2 &&
      (firstChoiceHasCursor ||
        parsedChoices.some((c) => c.hasCursor) ||
        CHOICE_HINT_RE.test(afterText));

    if (isMenu) {
      title = extractOverlayTitle(tailLines, firstChoiceIdx);
      for (const choice of parsedChoices) {
        const key = normalizeChoiceKey(choice.num, choice.label);
        options.push({
          key,
          label: `${choice.num}. ${choice.label}`,
          ...(choice.detail ? { detail: choice.detail } : {}),
          command: { kind: 'key', data: String(choice.num) },
        });
      }
    }
  }

  // Also detect paused/usage-limit goal status lines when the popup overlay itself isn't open.
  const hasGoalFooter =
    /goal\s+(?:hit\s+usage\s+lim\S*|paused)[^\n]*\/goal\s+resume|\(\/goal\s+resume\b/i.test(screen);
  if (hasGoalFooter && !options.some((o) => o.key === 'resume-goal')) {
    if (!title) title = 'Goal paused (/goal resume)';
    options.push({
      key: 'resume-goal',
      label: '1. Resume goal',
      detail: 'Send /goal resume to mark it active and continue when idle',
      command: { kind: 'line', text: '/goal resume' },
    });
    options.push({
      key: 'pause-goal',
      label: '2. Leave paused',
      detail: 'Keep it paused; use /goal resume later',
      command: { kind: 'line', text: '/goal pause' },
    });
  }

  // A Codex terminal at its usage limit with no menu open: auto-continue at the reset, or try
  // again now. Not when a paused goal is showing: /goal resume is the way back there.
  if (
    !options.length &&
    session?.providerId === 'codex' &&
    session.terminal === 'pty' &&
    (session.usageLimit || /you[’']ve hit your usage limit/i.test(tailLines.slice(-20).join('\n')))
  ) {
    title = 'Usage limit reached';
    options.push(...usageLimitOptions());
  }

  if (!options.length) {
    const tailText = tailLines.slice(-8).join('\n');
    if (/[[(]\s*y\s*\/\s*n\s*[\])]/i.test(tailText)) {
      title = extractOverlayTitle(tailLines, tailLines.length - 1);
      options.push(
        { key: 'yn:y', label: 'Yes (y)', command: { kind: 'key', data: 'y' } },
        { key: 'yn:n', label: 'No (n)', command: { kind: 'key', data: 'n' } },
      );
    }
  }

  return options.length ? { title: title || 'CLI overlay', options } : null;
}

interface SessionOverlayState {
  session: AgentSession;
  loading: boolean;
  screen: string;
  overlay: DetectedAttentionOverlay | null;
}

/**
 * Batch processor for sessions in Needs attention (PM-165): reads each session's live CLI screen,
 * detects active overlays (such as "Resume paused goal?" / "Leave paused", usage-limit menus, or
 * approval prompts), and lets the user apply a choice across all matching sessions at once.
 */
export function BatchAttentionActions({
  sessions,
  isAttentionFilter = false,
}: {
  sessions: AgentSession[];
  isAttentionFilter?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sending = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const heading = useId();

  const [states, setStates] = useState<SessionOverlayState[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [deliveries, setDeliveries] = useState<{ id: number; name: string; detail: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [result, setResult] = useState('');
  const [progress, setProgress] = useState({
    completed: 0,
    total: 0,
    sent: 0,
    failed: 0,
    current: '',
  });

  const eligible = sessions.filter(
    (s) =>
      s.status === 'running' &&
      !s.restartProgress &&
      // Waiting for you, or stopped at its usage limit (which it shows rather than asks).
      (isAttentionFilter || s.tailState === 'input' || !!s.usageLimit),
  );

  async function inspectScreens(targets: AgentSession[]) {
    setStates(
      targets.map((session) => ({
        session,
        loading: true,
        screen: '',
        overlay: null,
      })),
    );
    setSelectedIds(new Set(targets.map((s) => s.id)));
    const loaded = await Promise.all(
      targets.map(async (session): Promise<SessionOverlayState> => {
        try {
          const { text } = await api.sessionScreen(session.id);
          return {
            session,
            loading: false,
            screen: text,
            overlay: detectAttentionOverlay(text, session),
          };
        } catch {
          return {
            session,
            loading: false,
            screen: '',
            overlay: null,
          };
        }
      }),
    );
    setStates(loaded);
  }

  async function sendCommand(target: AgentSession, cmd: AttentionCommand): Promise<boolean> {
    if (cmd.kind === 'auto-continue') {
      await api.setAutoContinue(target.id, true);
      return false;
    }
    if (cmd.kind === 'continue-now') {
      await api.continueSessionNow(target.id);
      return false;
    }
    if (cmd.kind === 'key') {
      const ack = await api.sendSessionInput(target.id, cmd.data);
      return ack.queued;
    }
    let queued = false;
    const data =
      target.terminal === 'pty'
        ? `\x1b[200~${cmd.text.replace(/\r\n?/g, '\n')}\x1b[201~`
        : cmd.text;
    for (const part of splitSessionInput(data)) {
      const ack = await api.sendSessionInput(target.id, part);
      queued ||= ack.queued;
    }
    const ack = await api.sendSessionInput(target.id, target.terminal === 'pty' ? '\r' : '\n');
    queued ||= ack.queued;
    return queued;
  }

  async function runBatchOption(
    label: string,
    resolveCommand: (entry: SessionOverlayState) => AttentionCommand | null,
  ) {
    if (sending.current) return;
    const matching = states.filter(
      (entry) => selectedIds.has(entry.session.id) && resolveCommand(entry) !== null,
    );
    if (!matching.length) return;

    sending.current = true;
    setBusy(true);
    clearTimeout(closeTimer.current);
    setClosing(false);
    setResult('');
    setDeliveries([]);
    setProgress({
      completed: 0,
      total: matching.length,
      sent: 0,
      failed: 0,
      current: '',
    });

    const failed: AgentSession[] = [];
    let queuedCount = 0;

    for (const entry of matching) {
      const { session } = entry;
      const cmd = resolveCommand(entry)!;
      setProgress((p) => ({ ...p, current: session.name }));
      try {
        const queued = await sendCommand(session, cmd);
        if (queued) queuedCount++;
        setDeliveries((rows) => [
          ...rows.filter((r) => r.id !== session.id),
          {
            id: session.id,
            name: session.name,
            detail: queued
              ? `Queued "${label}" for reconnection.`
              : cmd.kind === 'key' || cmd.kind === 'line'
                ? `Applied "${label}" (${cmd.kind === 'key' ? `key ${JSON.stringify(cmd.data)}` : cmd.text}).`
                : `Applied "${label}".`,
          },
        ]);
      } catch (error) {
        failed.push(session);
        setDeliveries((rows) => [
          ...rows.filter((r) => r.id !== session.id),
          {
            id: session.id,
            name: session.name,
            detail: `Failed: ${error instanceof Error ? error.message : 'Request failed'}.`,
          },
        ]);
      }
      setProgress((p) => ({
        ...p,
        completed: p.completed + 1,
        sent: p.completed + 1 - failed.length - queuedCount,
        failed: failed.length,
      }));
    }

    setResult(
      `Applied "${label}" to ${matching.length - failed.length - queuedCount} of ${matching.length} sessions.${queuedCount ? ` ${queuedCount} queued.` : ''}${failed.length ? ` Failed: ${failed.map((s) => s.name).join(', ')}.` : ''}`,
    );
    setBusy(false);
    sending.current = false;
    // Retry only failures: delivered and queued commands must not be submitted twice.
    setSelectedIds(new Set(failed.map((session) => session.id)));
    if (!failed.length && !queuedCount) {
      setClosing(true);
      closeTimer.current = setTimeout(() => {
        dialog.current?.close();
        setClosing(false);
      }, 2500);
    }
  }

  // Group detected overlay options across currently selected sessions.
  const groupedOptions: {
    key: string;
    label: string;
    detail?: string;
    sessions: SessionOverlayState[];
  }[] = [];
  const groupMap = new Map<string, (typeof groupedOptions)[number]>();

  for (const entry of states) {
    if (!selectedIds.has(entry.session.id) || !entry.overlay) continue;
    for (const opt of entry.overlay.options) {
      let group = groupMap.get(opt.key);
      if (!group) {
        group = {
          key: opt.key,
          label: opt.label,
          ...(opt.detail ? { detail: opt.detail } : {}),
          sessions: [],
        };
        groupMap.set(opt.key, group);
        groupedOptions.push(group);
      }
      group.sessions.push(entry);
    }
  }

  const selectedStates = states.filter((entry) => selectedIds.has(entry.session.id));
  const scanning = states.some((entry) => entry.loading);

  if (!isAttentionFilter && eligible.length === 0) return null;

  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        disabled={!eligible.length}
        onClick={() => {
          const snapshot = [...eligible];
          setDeliveries([]);
          clearTimeout(closeTimer.current);
          setClosing(false);
          setResult('');
          setProgress({ completed: 0, total: 0, sent: 0, failed: 0, current: '' });
          dialog.current?.showModal();
          void inspectScreens(snapshot);
        }}
      >
        Batch CLI choices ({eligible.length})
      </button>
      <dialog
        ref={dialog}
        className="confirm-dialog batch-message-dialog"
        aria-labelledby={heading}
        onClose={() => {
          clearTimeout(closeTimer.current);
          setClosing(false);
        }}
        onCancel={(e) => {
          if (sending.current) e.preventDefault();
        }}
      >
        <div className="dialog-body">
          <h2 id={heading} tabIndex={-1} autoFocus>
            Batch process Needs attention CLIs ({selectedStates.length}/{states.length})
          </h2>
          <p className="faint" style={{ margin: '0 0 10px' }}>
            Detects active CLI overlays (such as paused-goal prompts, usage-limit choices, and
            approval menus) and applies your choice across matching sessions.
          </p>

          {scanning ? (
            <p role="status" className="faint">
              Inspecting {states.length} terminal screens…
            </p>
          ) : (
            <>
              {groupedOptions.length > 0 && (
                <div
                  role="group"
                  aria-label="Detected CLI overlay options"
                  style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}
                >
                  <strong style={{ fontSize: 12.5 }}>Detected overlay options</strong>
                  {groupedOptions.map((group) => (
                    <div
                      key={group.key}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10,
                        flexWrap: 'wrap',
                        padding: '8px 10px',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        background: 'var(--surface-2)',
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 180 }}>
                        <b>{group.label}</b>
                        {group.detail && (
                          <span className="faint" style={{ fontSize: 12.5 }}>
                            {' '}
                            · {group.detail}
                          </span>
                        )}
                        <div className="faint" style={{ fontSize: 11.5 }}>
                          {group.sessions.map((s) => s.session.name).join(', ')}
                        </div>
                      </span>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy}
                        onClick={() =>
                          void runBatchOption(group.label, (entry) => {
                            const found = entry.overlay?.options.find((o) => o.key === group.key);
                            return found?.command ?? null;
                          })
                        }
                      >
                        Apply ({group.sessions.length})
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div
                role="group"
                aria-label="Quick goal and overlay actions"
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  alignItems: 'center',
                  marginBottom: 12,
                }}
              >
                <span className="faint" style={{ fontSize: 12, marginRight: 4 }}>
                  Quick batch actions:
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || !selectedStates.length}
                  onClick={() =>
                    void runBatchOption('Resume goal', (entry) => {
                      const opt = entry.overlay?.options.find((o) => o.key === 'resume-goal');
                      return opt ? opt.command : { kind: 'line', text: '/goal resume' };
                    })
                  }
                >
                  Resume goal ({selectedStates.length})
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || !selectedStates.length}
                  onClick={() =>
                    void runBatchOption('Leave paused', (entry) => {
                      const opt = entry.overlay?.options.find((o) => o.key === 'pause-goal');
                      return opt ? opt.command : { kind: 'key', data: '2' };
                    })
                  }
                >
                  Leave paused ({selectedStates.length})
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || !selectedStates.length}
                  onClick={() =>
                    void runBatchOption('Option 1', () => ({ kind: 'key', data: '1' }))
                  }
                >
                  Press 1 ({selectedStates.length})
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || !selectedStates.length}
                  onClick={() =>
                    void runBatchOption('Option 2', () => ({ kind: 'key', data: '2' }))
                  }
                >
                  Press 2 ({selectedStates.length})
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || !selectedStates.length}
                  onClick={() => void runBatchOption('Enter', () => ({ kind: 'key', data: '\r' }))}
                >
                  Press Enter ({selectedStates.length})
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || !selectedStates.length}
                  onClick={() => void runBatchOption('Esc', () => ({ kind: 'key', data: '\x1b' }))}
                >
                  Press Esc ({selectedStates.length})
                </button>
              </div>

              <ul
                className="list"
                style={{ maxHeight: 180, overflowY: 'auto', marginBottom: 8 }}
                aria-label="Sessions needing attention"
              >
                {states.map((entry) => {
                  const checked = selectedIds.has(entry.session.id);
                  return (
                    <li key={entry.session.id} style={{ alignItems: 'center' }}>
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          flex: 1,
                          minWidth: 0,
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy}
                          onChange={() =>
                            setSelectedIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(entry.session.id)) next.delete(entry.session.id);
                              else next.add(entry.session.id);
                              return next;
                            })
                          }
                        />
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <b>{entry.session.name}</b>{' '}
                          <span className="faint" style={{ fontSize: 12 }}>
                            {entry.overlay
                              ? `· ${entry.overlay.title} (${entry.overlay.options.map((o) => o.label).join(' / ')})`
                              : '· no overlay menu detected'}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {progress.total > 0 && (
            <progress
              value={progress.completed}
              max={progress.total || 1}
              aria-label="Batch overlay progress"
              style={{ width: '100%' }}
            />
          )}
          <p role="status" aria-live="polite" aria-atomic="true">
            {busy
              ? `${progress.completed}/${progress.total} complete · ${progress.current} · ${progress.sent} applied${progress.failed ? ` · ${progress.failed} failed` : ''}`
              : result}
          </p>
          {deliveries.length > 0 && (
            <ul style={{ maxHeight: 140, overflowY: 'auto' }} aria-label="Batch action results">
              {deliveries.map((row) => (
                <li key={row.id}>
                  <strong>{row.name}</strong>: {row.detail}
                </li>
              ))}
            </ul>
          )}
          {closing && (
            <p className="faint">All actions applied. Closing automatically in 2.5 seconds.</p>
          )}
        </div>
        <div className="dialog-footer">
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || scanning}
            onClick={() => void inspectScreens(states.map((s) => s.session))}
          >
            Refresh screens
          </button>
          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                clearTimeout(closeTimer.current);
                dialog.current?.close();
                setClosing(false);
              }}
            >
              Close
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
