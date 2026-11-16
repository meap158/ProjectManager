import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { api } from '../api';
import { droppedFiles, isImageFile, prepareImage } from '../sessionImages';
import { Lightbox } from './Lightbox';
import './session-chat.css';

// A message box under a CLI terminal (PM-726). What you write here stays in this page until you
// send it, then goes to the CLI in one piece (a paste and Enter). The CLI's own input box stays
// empty meanwhile, so the app's automatic messages (orchestrator checks, worker messages) can
// still go in on time without joining your half-written text. A CLI that is busy queues it.
// Images (PM-929) are pasted, dropped or picked here like in the CLI chat: each is uploaded, shown
// as a thumbnail, and sent as its path in a paste of its own (how the CLIs recognise an image).

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

/** An image path as its own paste, so the CLI recognises it as an attachment. */
export function imagePayload(path: string): string {
  return `\x1b[200~${path.replaceAll('\x1b[201~', '')}\x1b[201~`;
}

interface Attachment {
  id: number;
  status: 'uploading' | 'ready' | 'failed';
  path: string | null;
  name: string;
  preview: string;
}
let attachmentSeq = 0;

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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [imageError, setImageError] = useState('');
  const [dragging, setDragging] = useState(false);
  /** The thumbnail open in the lightbox (PM-929), by attachment id. */
  const [viewing, setViewing] = useState<number | null>(null);
  const sendLock = useRef(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const files = useRef(new Map<number, File>());
  const uploads = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef<Attachment[]>([]);
  useEffect(() => {
    latest.current = attachments;
  }, [attachments]);
  useEffect(() => saveDraft(sessionId, text), [sessionId, text]);
  // Previews are object URLs: give the memory back when the box goes away.
  useEffect(
    () => () => {
      for (const a of latest.current) URL.revokeObjectURL(a.preview);
    },
    [],
  );

  // Grows with the message up to a few lines, then scrolls.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
  }, [text]);

  const viewIndex = attachments.findIndex((a) => a.id === viewing);
  const shown = viewIndex >= 0 ? attachments[viewIndex] : undefined;
  const uploading = attachments.some((a) => a.status === 'uploading');
  const ready = attachments.filter((a) => a.status === 'ready');

  const upload = async (key: number, file: File) => {
    try {
      const { path } = await api.uploadSessionImage(sessionId, await prepareImage(file));
      files.current.delete(key);
      setAttachments((prev) =>
        prev.map((a) => (a.id === key ? { ...a, status: 'ready', path } : a)),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not upload the image';
      setImageError(`Couldn't add ${file.name || 'the image'}: ${message}`);
      setAttachments((prev) => prev.map((a) => (a.id === key ? { ...a, status: 'failed' } : a)));
    }
  };

  const addImages = (picked: File[]) => {
    const images = picked.filter(isImageFile);
    if (picked.length && !images.length) setImageError('That file is not an image.');
    if (!images.length) return;
    setImageError('');
    const added: Attachment[] = images.map((file) => {
      const id = ++attachmentSeq;
      files.current.set(id, file);
      return {
        id,
        status: 'uploading',
        path: null,
        name: file.name || 'image',
        preview: URL.createObjectURL(file),
      };
    });
    setAttachments((prev) => [...prev, ...added]);
    // One at a time: decoding a large screenshot is heavy, and the order stays the order added.
    for (const a of added) {
      uploads.current = uploads.current.then(() => {
        const file = files.current.get(a.id);
        return file ? upload(a.id, file) : undefined; // Removed before its turn came.
      });
    }
  };

  const retry = (key: number) => {
    const file = files.current.get(key);
    if (!file) return;
    setImageError('');
    setAttachments((prev) => prev.map((a) => (a.id === key ? { ...a, status: 'uploading' } : a)));
    uploads.current = uploads.current.then(() => upload(key, file));
  };

  const remove = (key: number) => {
    files.current.delete(key);
    setViewing((current) => (current === key ? null : current));
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === key);
      if (gone) URL.revokeObjectURL(gone.preview);
      return prev.filter((a) => a.id !== key);
    });
  };

  const send = async () => {
    const message = text.trim();
    const images = ready;
    if ((!message && !images.length) || uploading || sendLock.current || disabled) return;
    sendLock.current = true;
    setSending(true);
    try {
      // Each image is its own paste, in the order added, then the text and Enter.
      for (const image of images) {
        await api.sendSessionInput(sessionId, imagePayload(image.path!));
        remove(image.id);
      }
      await api.sendSessionInput(sessionId, message ? composerPayload(message) : '\r');
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

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = droppedFiles(e.clipboardData).filter(isImageFile);
    if (!images.length) return; // Text pastes as usual.
    e.preventDefault();
    addImages(images);
  };

  const onDrop = (e: DragEvent<HTMLFormElement>) => {
    setDragging(false);
    const dropped = droppedFiles(e.dataTransfer);
    if (!dropped.length) return;
    e.preventDefault();
    addImages(dropped);
  };

  return (
    <form
      className={`terminal-composer${dragging ? ' is-dragging' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {attachments.length > 0 && (
        <div className="terminal-composer-images chat-attachments" aria-label="Images to send">
          {attachments.map((a) => (
            <span
              key={a.id}
              className={`chat-attachment is-${a.status}`}
              title={a.name}
              aria-busy={a.status === 'uploading'}
            >
              <button
                type="button"
                className="chat-attachment-open"
                aria-label={`View ${a.name} larger`}
                title="View larger"
                onClick={() => setViewing(a.id)}
              >
                <img src={a.preview} alt={a.name} />
              </button>
              {a.status === 'uploading' && (
                <span className="chat-attachment-state" role="status">
                  <span className="spinner" aria-hidden="true" />
                  <span className="sr-only">Uploading {a.name}</span>
                </span>
              )}
              {a.status === 'failed' && (
                <button
                  type="button"
                  className="chat-attachment-retry"
                  aria-label={`Retry ${a.name}`}
                  onClick={() => retry(a.id)}
                >
                  Retry
                </button>
              )}
              <button
                type="button"
                className="chat-attachment-remove"
                aria-label={`Remove ${a.name}`}
                onClick={() => remove(a.id)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </span>
          ))}
        </div>
      )}
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
        onPaste={onPaste}
      />
      <span className="terminal-composer-actions">
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            addImages([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="btn terminal-composer-send terminal-composer-image"
          aria-label="Add an image"
          title="Add an image (or paste or drop one)"
          disabled={disabled}
          onClick={() => picker.current?.click()}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <circle cx="9" cy="10" r="1.6" />
            <path d="m21 16-5-5-9 9" />
          </svg>
        </button>
        <button
          type="submit"
          className="btn btn-primary terminal-composer-send"
          aria-label={sending ? 'Sending message' : 'Send'}
          disabled={disabled || sending || uploading || (!text.trim() && !ready.length)}
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
      </span>
      <Lightbox
        src={shown?.preview ?? null}
        alt={shown?.name ?? ''}
        {...(attachments.length > 1 && shown
          ? { caption: `${viewIndex + 1} of ${attachments.length} · ${shown.name}` }
          : {})}
        onClose={() => setViewing(null)}
        {...(viewIndex > 0 ? { onPrevious: () => setViewing(attachments[viewIndex - 1]!.id) } : {})}
        {...(viewIndex >= 0 && viewIndex < attachments.length - 1
          ? { onNext: () => setViewing(attachments[viewIndex + 1]!.id) }
          : {})}
      />
      {imageError && (
        <span className="terminal-composer-hint is-error" role="alert">
          {imageError}
        </span>
      )}
      <span className="terminal-composer-hint">
        Enter to send · Shift+Enter for a new line · paste or drop an image
      </span>
    </form>
  );
}
