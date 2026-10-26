import { useRef, useState, type MutableRefObject } from 'react';
import { sendImageToSession, type PasteTarget } from '../sessionImages';

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
  pasteRef: MutableRefObject<PasteTarget | null>;
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
        title="Add images to this session (their paths are pasted into the CLI)"
        aria-label="Add images"
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
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = ''; // Picking the same photo again still fires.
          if (!files.length) return;
          // The chat is showing: it takes the images itself (instant previews, remove, retry).
          const target = pasteRef.current;
          if (target?.addImages) {
            target.addImages(files);
            return;
          }
          setBusy(true);
          // Process photos in order, keeping only one decoded image/upload in memory.
          // A failed photo does not prevent the remaining selections from being added.
          const paste = pasteRef.current;
          const send = async () => {
            for (const file of files) {
              try {
                await sendImageToSession(sessionId, file, paste);
              } catch (err) {
                onError(
                  `${file.name}: ${err instanceof Error ? err.message : 'Could not add image'}`,
                );
              }
            }
          };
          void send().finally(() => setBusy(false));
        }}
      />
    </>
  );
}
