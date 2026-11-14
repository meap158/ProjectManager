import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api';

// A message box under a CLI terminal (PM-726). What you write here stays in this page until you
// send it, then goes to the CLI in one piece (a paste and Enter). The CLI's own input box stays
// empty meanwhile, so the app's automatic messages (orchestrator checks, worker messages) can
// still go in on time without joining your half-written text. A CLI that is busy queues it.

const DRAFT_KEY = 'pm.terminalComposer.';

function readDraft(sessionId: number): string {
  try {
    return localStorage.getItem(DRAFT_KEY + sessionId) ?? '';
  } catch {
    return '';
  }
}

function saveDraft(sessionId: number, text: string): void {
  try {
    if (text) localStorage.setItem(DRAFT_KEY + sessionId, text);
    else localStorage.removeItem(DRAFT_KEY + sessionId);
  } catch {
    // Keeping the draft across reloads is a convenience only.
  }
}

/** What the CLI receives for a message: one bracketed paste, then Enter. */
export function composerPayload(text: string): string {
  // A paste-end marker inside the text would end the paste early; never forward it.
  return `\x1b[200~${text.replaceAll('\x1b[201~', '')}\x1b[201~\r`;
}

export function TerminalComposer({
  sessionId,
  disabled,
  onError,
}: {
  sessionId: number;
  disabled: boolean;
  onError: (message: string) => void;
}) {
  const [text, setText] = useState(() => readDraft(sessionId));
  const [sending, setSending] = useState(false);
  const sendLock = useRef(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => saveDraft(sessionId, text), [sessionId, text]);

  // Grows with the message up to a few lines, then scrolls.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
  }, [text]);

  const send = async () => {
    const message = text.trim();
    if (!message || sendLock.current || disabled) return;
    sendLock.current = true;
    setSending(true);
    try {
      await api.sendSessionInput(sessionId, composerPayload(message));
      setText((current) => (current === text ? '' : current));
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not send the message');
    } finally {
      sendLock.current = false;
      setSending(false);
      boxRef.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <form
      className="terminal-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <textarea
        ref={boxRef}
        className="input terminal-composer-input"
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={disabled ? 'Start the chat to send it a message' : 'Message the orchestrator…'}
        aria-label="Message to the chat"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="submit"
        className="btn btn-primary terminal-composer-send"
        aria-label={sending ? 'Sending message' : 'Send'}
        disabled={disabled || sending || !text.trim()}
        title="Send (Enter). Shift+Enter adds a line."
      >
        {sending ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 19V5m-6 6 6-6 6 6" />
          </svg>
        )}
      </button>
      <span className="terminal-composer-hint">Enter to send · Shift+Enter for a new line</span>
    </form>
  );
}
