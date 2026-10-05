import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { CardAttachment } from '../../../shared/types';
import { api } from '../api';
import { formatBytes } from '../format';
import { ConfirmDelete } from './ConfirmDelete';
import { Lightbox } from './Lightbox';

const ACCEPT = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024;

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

/** Images from a paste or a drop (screenshots paste straight from the clipboard). */
export function imageFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const files: File[] = [];
  for (const entry of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    const file = entry instanceof File ? entry : entry.kind === 'file' ? entry.getAsFile() : null;
    if (file && ACCEPT.includes(file.type)) files.push(file);
  }
  return files;
}

/**
 * Images attached to a card as context: added with the button, by pasting a screenshot anywhere
 * in the dialog (the parent forwards paste events via `pasteRef`), or by dropping files here.
 * Thumbnails open a lightbox. Agents handed the card get the images' paths with the task.
 */
export function CardImages({
  cardId,
  pasteRef,
  onPendingChange,
  onBusyChange,
}: {
  cardId: number;
  onBusyChange?: (busy: boolean) => void;
  onPendingChange?: (images: { name: string; type: string; data: string }[]) => void;
  /** Set to this component's paste handler so the whole dialog accepts pasted images. */
  pasteRef?: { current: ((event: ClipboardEvent) => void) | null };
}) {
  const pending = useRef<{ name: string; type: string; data: string }[]>([]);
  const [images, setImages] = useState<CardAttachment[] | null>(null);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onBusyChange?.(busy > 0);
  }, [busy, onBusyChange]);

  useEffect(() => {
    let active = true;
    (cardId ? api.listAttachments(cardId) : Promise.resolve([])).then(
      (list) => active && setImages(list),
      (e: Error) => active && setError(e.message),
    );
    return () => {
      active = false;
    };
  }, [cardId]);

  async function add(files: File[]) {
    setError(null);
    for (const file of files) {
      if (file.size > MAX_BYTES) {
        setError(`${file.name} is over 8 MB`);
        continue;
      }
      setBusy((n) => n + 1);
      try {
        const image = {
          name: file.name || 'pasted image.png',
          type: file.type,
          data: await toBase64(file),
        };
        if (!cardId && pending.current.length >= 20) throw new Error('At most 20 images per card');
        const added = cardId
          ? await api.addAttachment(cardId, image)
          : {
              file: crypto.randomUUID(),
              name: image.name,
              type: image.type,
              bytes: file.size,
              addedAt: new Date().toISOString(),
              url: `data:${image.type};base64,${image.data}`,
            };
        if (!cardId) {
          pending.current.push(image);
          onPendingChange?.([...pending.current]);
        }
        setImages((prev) => [...(prev ?? []), added]);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy((n) => n - 1);
      }
    }
  }

  const onPaste = (event: ClipboardEvent) => {
    const files = imageFiles(event.clipboardData?.items);
    if (files.length === 0) return; // Text pastes go where they were meant to.
    event.preventDefault();
    void add(files);
  };
  useEffect(() => {
    if (pasteRef) pasteRef.current = onPaste;
  });

  const count = images?.length ?? 0;
  const at = openAt === null || count === 0 ? null : Math.min(openAt, count - 1);
  const shown = at !== null ? images![at]! : null;

  return (
    <div
      className={`card-images${dragOver ? ' is-drop' : ''}`}
      onDragOver={(e: DragEvent) => {
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        void add(imageFiles(e.dataTransfer.files));
      }}
    >
      {images === null ? (
        <div className="skeleton" style={{ height: 64 }} />
      ) : (
        <ul className="card-image-list">
          {images.map((img, i) => (
            <li key={img.file}>
              <button
                type="button"
                className="card-image-thumb"
                title={`${img.name} · ${formatBytes(img.bytes)} · click to enlarge`}
                onClick={() => setOpenAt(i)}
              >
                <img src={img.url} alt={img.name} loading="lazy" />
              </button>
              <span className="card-image-remove">
                <ConfirmDelete
                  label={`Remove ${img.name}`}
                  heading={`Remove ${img.name}?`}
                  message="The image is deleted from this card. Agents already working on it keep their copy of the task."
                  confirmLabel="Remove"
                  onConfirm={() =>
                    (cardId
                      ? api.deleteAttachment(cardId, img.file)
                      : Promise.resolve().then(() => {
                          pending.current = pending.current.filter((_, index) => index !== i);
                          onPendingChange?.([...pending.current]);
                        })
                    ).then(
                      () => setImages((prev) => prev?.filter((x) => x.file !== img.file) ?? prev),
                      (e: Error) => setError(e.message),
                    )
                  }
                />
              </span>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="card-image-add"
              title="Add PNG, JPEG, GIF or WebP images (up to 8 MB). You can also paste a screenshot or drop files here."
              onClick={() => input.current?.click()}
              disabled={busy > 0}
            >
              {busy > 0 ? <span className="spinner" /> : '＋'}
              <span>{busy > 0 ? 'Uploading…' : 'Add images'}</span>
            </button>
          </li>
        </ul>
      )}
      <input
        ref={input}
        type="file"
        accept={ACCEPT.join(',')}
        multiple
        hidden
        onChange={(e) => {
          void add(imageFiles(e.target.files));
          e.target.value = '';
        }}
      />
      <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
        Paste a screenshot, drop files, or use Add images. Agents get the images with the task.
      </p>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <Lightbox
        src={shown?.url ?? null}
        alt={shown?.name ?? ''}
        onClose={() => setOpenAt(null)}
        {...(at !== null && at > 0 ? { onPrevious: () => setOpenAt(at - 1) } : {})}
        {...(at !== null && at < count - 1 ? { onNext: () => setOpenAt(at + 1) } : {})}
      />
    </div>
  );
}
