import { useId, useRef, useState, type ReactNode } from 'react';
import { useShortcutProps, useShortcutTitle, type ShortcutId } from '../shortcuts';

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.75 6.5v4.5M9.25 6.5v4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Standard destructive action: a danger button that opens a confirmation dialog naming what will
 * happen ("Delete card PM-1?"), with Cancel (focused) and a red confirm button. Pass `text` for a
 * labelled button; without it the button is icon-only and `label` is its tooltip/accessible name.
 * Other consequential actions (merging a pull request) reuse it with `tone="primary"` and their
 * own `icon` (null for none), so every confirmation in the app looks and behaves the same.
 */
export function ConfirmDelete({
  label,
  text,
  heading,
  message,
  confirmLabel = 'Delete',
  onConfirm,
  tone = 'danger',
  icon,
  small,
  disabled,
  shortcut,
  hideTrigger = false,
  onDismiss,
}: {
  /** The keyboard shortcut that opens this confirmation (PM-244): shown in the tooltip only. */
  shortcut?: ShortcutId;
  label: string;
  text?: string;
  heading: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  /** primary: an accent button and confirm, for actions that aren't deletions (merge). */
  tone?: 'danger' | 'primary';
  /** Replaces the trash icon; null shows none. */
  icon?: ReactNode;
  small?: boolean;
  disabled?: boolean;
  /** For a confirmation opened from an action menu rather than its own visible button. */
  hideTrigger?: boolean;
  onDismiss?: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const headingId = useId();
  const keys = useShortcutProps(shortcut);
  const title = useShortcutTitle(shortcut, label);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      dialogRef.current?.close();
    }
  }

  return (
    <>
      <button
        type="button"
        style={hideTrigger ? { display: 'none' } : undefined}
        className={`btn ${tone === 'primary' ? 'btn-primary' : 'btn-danger'}${text ? '' : ' btn-icon'}${small ? ' btn-sm' : ''}`}
        disabled={disabled}
        title={title}
        aria-label={text ? undefined : label}
        {...keys}
        onClick={() => {
          dialogRef.current?.showModal();
          cancelRef.current?.focus();
        }}
      >
        {icon === undefined ? <TrashIcon /> : icon}
        {text}
      </button>
      <dialog
        ref={dialogRef}
        className="confirm-dialog"
        aria-labelledby={headingId}
        // React passes a nested dialog's close up the component tree: cancelling here must not
        // also close a dialog this one was opened from (e.g. the card dialog).
        onClose={(e) => {
          e.stopPropagation();
          onDismiss?.();
        }}
      >
        <div className="dialog-body">
          <h2 id={headingId}>{heading}</h2>
          <p>{message}</p>
        </div>
        <div className="dialog-footer">
          <span />
          <div className="actions">
            <button
              ref={cancelRef}
              type="button"
              className="btn"
              onClick={() => dialogRef.current?.close()}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`btn ${tone === 'primary' ? 'btn-primary' : 'btn-danger-solid'}`}
              disabled={busy}
              onClick={confirm}
            >
              {busy ? 'Working…' : confirmLabel}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
