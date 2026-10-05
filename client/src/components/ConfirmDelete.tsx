import { useId, useRef, useState } from 'react';

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
 */
export function ConfirmDelete({
  label,
  text,
  heading,
  message,
  confirmLabel = 'Delete',
  onConfirm,
}: {
  label: string;
  text?: string;
  heading: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const headingId = useId();

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
        className={`btn btn-danger${text ? '' : ' btn-icon'}`}
        title={label}
        aria-label={text ? undefined : label}
        onClick={() => {
          dialogRef.current?.showModal();
          cancelRef.current?.focus();
        }}
      >
        <TrashIcon />
        {text}
      </button>
      <dialog ref={dialogRef} className="confirm-dialog" aria-labelledby={headingId}>
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
              className="btn btn-danger-solid"
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
