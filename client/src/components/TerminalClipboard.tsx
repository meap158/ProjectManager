import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Native editable paste target also works on HTTP LAN pages without Clipboard.read. */
export function TerminalClipboard({
  onImage,
  onText,
  disabled,
}: {
  onImage?: (file: File) => void;
  onText: (text: string) => void;
  disabled: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const accept = (files: File[], text: string) => {
    if (files.length && onImage) files.forEach((file) => onImage(file));
    else if (text) onText(text);
    else {
      setError('No image or text was provided. Try copying the photo again, or use Add images.');
      return;
    }
    if (field.current) field.current.textContent = '';
    dialog.current?.close();
  };
  return (
    <>
      <button
        type="button"
        aria-label="Paste image or text"
        disabled={disabled}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          setError('');
          dialog.current?.showModal();
          field.current?.focus({ preventScroll: true });
        }}
      >
        Paste
      </button>
      {createPortal(
        <dialog
          ref={dialog}
          className="confirm-dialog terminal-clipboard-dialog"
          aria-label="Paste into terminal"
        >
          <div className="dialog-body">
            <h2>Paste into terminal</h2>
            <p>
              Touch and hold the field, then choose Paste. Images are attached; text is added
              without pressing Enter.
            </p>
            <div
              ref={field}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-label="Clipboard paste field"
              tabIndex={0}
              style={{
                minHeight: 72,
                padding: 12,
                fontSize: 16,
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
              }}
              onPaste={(event) => {
                event.preventDefault();
                const files = Array.from(event.clipboardData.files).filter((file) =>
                  file.type.startsWith('image/'),
                );
                if (!files.length)
                  for (const item of Array.from(event.clipboardData.items)) {
                    if (item.kind === 'file' && item.type.startsWith('image/')) {
                      const file = item.getAsFile();
                      if (file) files.push(file);
                    }
                  }
                accept(files, event.clipboardData.getData('text/plain'));
              }}
            />
            {error && <p role="alert">{error}</p>}
          </div>
          <div className="dialog-footer">
            <span />{' '}
            <div className="actions">
              {navigator.clipboard?.read && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    // Start inside the user gesture; Safari may show its native Paste prompt.
                    void navigator.clipboard
                      .read()
                      .then(async (items) => {
                        const files: File[] = [];
                        let text = '';
                        for (const item of items) {
                          const type = item.types.find((value) => value.startsWith('image/'));
                          if (type)
                            files.push(
                              new File([await item.getType(type)], 'clipboard-image', { type }),
                            );
                          else if (item.types.includes('text/plain'))
                            text += await (await item.getType('text/plain')).text();
                        }
                        accept(files, text);
                      })
                      .catch(() =>
                        setError(
                          'Clipboard access was unavailable. Touch and hold the field and choose Paste, or use Add images.',
                        ),
                      );
                  }}
                >
                  Read clipboard
                </button>
              )}
              <button type="button" className="btn" onClick={() => dialog.current?.close()}>
                Close
              </button>
            </div>
          </div>
        </dialog>,
        document.body,
      )}
    </>
  );
}
