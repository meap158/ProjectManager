import { useEffect, useRef } from 'react';

/**
 * One picture as large as the window allows, after TrendRelay's lightbox: a dark stage with no
 * chrome but a close button and previous/next chevrons where a neighbour exists. Clicking the
 * dark area closes it; clicking the picture doesn't. Arrow keys step, Escape closes. Built on the
 * native modal <dialog> (focus trap, Escape, focus restore, and it stacks above the card dialog
 * that opens it), so no dialog library is needed.
 */
export function Lightbox({
  src,
  alt,
  onClose,
  onPrevious,
  onNext,
}: {
  /** null keeps it closed. */
  src: string | null;
  alt: string;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const open = src !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const go =
        event.key === 'ArrowLeft' ? onPrevious : event.key === 'ArrowRight' ? onNext : undefined;
      if (!go) return;
      event.preventDefault();
      go();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onPrevious, onNext]);

  return (
    <dialog
      ref={ref}
      className="lightbox"
      aria-label={alt}
      onClose={(e) => {
        // React passes a nested dialog's close up the component tree; keep it from closing
        // the card dialog this lightbox was opened from.
        e.stopPropagation();
        onClose();
      }}
      onClick={onClose}
    >
      {src && <img src={src} alt={alt} onClick={(e) => e.stopPropagation()} />}
      {onPrevious && (
        <button
          type="button"
          className="lightbox-step lightbox-previous"
          aria-label="Previous image"
          onClick={(e) => {
            e.stopPropagation();
            onPrevious();
          }}
        >
          ‹
        </button>
      )}
      {onNext && (
        <button
          type="button"
          className="lightbox-step lightbox-next"
          aria-label="Next image"
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
        >
          ›
        </button>
      )}
      <button type="button" className="lightbox-close" aria-label="Close" onClick={onClose}>
        ✕
      </button>
    </dialog>
  );
}
