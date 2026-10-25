import { useEffect, useId, useRef, useState } from 'react';
import type { AgentSession } from '../../../shared/types';
import { api } from '../api';
import { splitSessionInput } from '../lib/sessionInput';

/** Snapshot recipients when composing; never silently include newly matching sessions. */
export function BatchSessionMessage({ sessions }: { sessions: AgentSession[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const heading = useId();
  const [targets, setTargets] = useState<AgentSession[]>([]);
  const [recipients, setRecipients] = useState<AgentSession[]>([]);
  const [deliveries, setDeliveries] = useState<{ id: number; name: string; detail: string }[]>([]);
  const [closing, setClosing] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [progress, setProgress] = useState({
    completed: 0,
    total: 0,
    sent: 0,
    failed: 0,
    current: '',
    stage: '',
  });
  const eligible = sessions.filter((s) => s.status === 'running' && !s.restartProgress);
  async function send() {
    if (sending.current || !message.trim() || !targets.length) return;
    sending.current = true;
    setBusy(true);
    const failed: AgentSession[] = [];
    let queuedCount = 0;
    clearTimeout(closeTimer.current);
    setClosing(false);
    setResult('');
    setProgress({
      completed: 0,
      total: targets.length,
      sent: 0,
      failed: 0,
      current: '',
      stage: '',
    });
    for (const target of targets) {
      setProgress((p) => ({ ...p, current: target.name, stage: 'Adding message' }));
      try {
        let queued = false;
        // Bracketed paste prevents embedded newlines from submitting separate commands.
        const data =
          target.terminal === 'pty'
            ? `\x1b[200~${message.replace(/\r\n?/g, '\n')}\x1b[201~`
            : message;
        for (const part of splitSessionInput(data)) {
          const acknowledgment = await api.sendSessionInput(target.id, part);
          queued ||= acknowledgment.queued;
        }
        setProgress((p) => ({ ...p, stage: 'Pressing Enter' }));
        const acknowledgment = await api.sendSessionInput(
          target.id,
          target.terminal === 'pty' ? '\r' : '\n',
        );
        queued ||= acknowledgment.queued;
        if (queued) queuedCount++;
        setDeliveries((rows) => [
          ...rows.filter((row) => row.id !== target.id),
          {
            id: target.id,
            name: target.name,
            detail: queued
              ? 'Queued for reconnection; delivery not confirmed.'
              : 'Delivered: message and Enter acknowledged by the server.',
          },
        ]);
      } catch (error) {
        failed.push(target);
        setDeliveries((rows) => [
          ...rows.filter((row) => row.id !== target.id),
          {
            id: target.id,
            name: target.name,
            detail: `Failed: ${error instanceof Error ? error.message : 'Delivery request failed'}. Input may be partially sent; check before retrying.`,
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
      `Sent to ${targets.length - failed.length - queuedCount} of ${targets.length} terminals.${queuedCount ? ` ${queuedCount} queued; delivery not confirmed.` : ''}${failed.length ? ` Failed: ${failed.map((s) => s.name).join(', ')}. Check their input before retrying.` : ''}`,
    );
    setTargets(failed);
    setBusy(false);
    sending.current = false;
    if (!failed.length && !queuedCount) {
      setClosing(true);
      closeTimer.current = setTimeout(() => {
        dialog.current?.close();
        setClosing(false);
      }, 3000);
    }
  }
  return (
    <>
      <button
        className="btn btn-sm"
        disabled={!eligible.length}
        onClick={() => {
          setTargets([...eligible]);
          setRecipients([...eligible]);
          setDeliveries([]);
          clearTimeout(closeTimer.current);
          setClosing(false);
          setMessage('');
          setResult('');
          setProgress({ completed: 0, total: 0, sent: 0, failed: 0, current: '', stage: '' });
          dialog.current?.showModal();
          // Keep phones steady; users choose when to open their software keyboard.
          if (!window.matchMedia?.('(max-width: 768px), (pointer: coarse)').matches) {
            messageInput.current?.focus({ preventScroll: true });
          }
        }}
      >
        Send message ({eligible.length})
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
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="dialog-body">
            <h2 id={heading} tabIndex={-1} autoFocus>
              {result && !busy
                ? 'Message delivery results'
                : `Send message to ${recipients.length} terminals`}
            </h2>
            <p className="faint">{recipients.map((s) => s.name).join(', ')}</p>
            <p>
              Appends to current terminal input and presses Enter. Shell terminals execute this
              input.
            </p>
            <label>
              Message
              <textarea
                ref={messageInput}
                className="textarea"
                value={message}
                disabled={busy}
                maxLength={16000}
                rows={4}
                onChange={(e) => setMessage(e.target.value)}
                required
              />
            </label>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => setMessage('continue')}
            >
              Use “continue”
            </button>
            {progress.total > 0 && (
              <progress
                value={progress.completed}
                max={progress.total || 1}
                aria-label="Terminal message delivery"
                style={{ width: '100%' }}
              />
            )}
            <p role="status" aria-live="polite" aria-atomic="true">
              {busy
                ? `${progress.completed}/${progress.total} complete · ${progress.stage}: ${progress.current} · ${progress.sent} sent${progress.failed ? ` · ${progress.failed} failed` : ''}`
                : result}
            </p>
            {deliveries.length > 0 && (
              <ul style={{ maxHeight: 160, overflowY: 'auto' }} aria-label="Delivery results">
                {deliveries.map((row) => (
                  <li key={row.id}>
                    <strong>{row.name}</strong>: {row.detail}
                  </li>
                ))}
              </ul>
            )}
            {closing && (
              <p className="faint">All messages delivered. Closing automatically in 3 seconds.</p>
            )}
            {progress.total > 0 && (
              <p className="faint">
                Sending one terminal at a time. Delivery does not mean the agent has replied.
              </p>
            )}
          </div>
          <div className="dialog-footer">
            <span />
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
              {targets.length > 0 && (
                <button
                  className="btn btn-primary"
                  disabled={busy || !message.trim() || !targets.length}
                >
                  {busy
                    ? `Sending ${progress.completed}/${progress.total}…`
                    : `Send to ${targets.length}`}
                </button>
              )}
            </div>
          </div>
        </form>
      </dialog>
    </>
  );
}
