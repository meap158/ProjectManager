import { useRef, useState, type MutableRefObject } from 'react';
import { sendImageToSession } from '../sessionImages';

/**
 * "Image" button for a live session's terminal header (PM-54): opens the photo picker (camera
 * and photos on a phone), uploads the image and pastes its path into the CLI. The same as
 * pasting or dropping an image onto the terminal, for devices without a usable clipboard.
 */
export function SessionImageButton({
  sessionId,
  pasteRef,
  onError,
  className = 'icon-btn',
}: {
  sessionId: number;
  pasteRef: MutableRefObject<((text: string) => void) | null>;
  onError: (message: string) => void;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={busy}
        title="Send an image to this session (its path is pasted in, like a dropped file)"
        aria-label="Send an image"
        onClick={() => input.current?.click()}
      >
        {busy ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <rect
              x="2"
              y="3"
              width="12"
              height="10"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <circle cx="6" cy="6.5" r="1.2" fill="currentColor" />
            <path
              d="M3 12l3.5-3.5 2.5 2.5 1.5-1.5L14 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // Picking the same photo again still fires.
          if (!file) return;
          setBusy(true);
          sendImageToSession(sessionId, file, pasteRef.current)
            .catch((err: Error) => onError(err.message))
            .finally(() => setBusy(false));
        }}
      />
    </>
  );
}
