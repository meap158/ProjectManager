import { useState } from 'react';

/**
 * A separate pencil action renames the name in place: Enter or leaving the field saves, Escape cancels.
 * `onEditingChange` lets a draggable parent turn dragging off while the text box is open.
 */
export function InlineRename({
  value,
  label,
  onSave,
  onEditingChange,
  className,
}: {
  value: string;
  /** What is being renamed, e.g. "session". Used for the tooltip and the text box's name. */
  label: string;
  onSave: (name: string) => Promise<unknown>;
  onEditingChange?: (editing: boolean) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function setMode(next: boolean) {
    setEditing(next);
    onEditingChange?.(next);
  }

  async function save() {
    setMode(false);
    const name = draft.trim();
    if (name && name !== value) await onSave(name);
  }

  if (editing) {
    return (
      <input
        className={`input inline-rename-input ${className ?? ''}`}
        value={draft}
        autoFocus
        maxLength={80}
        aria-label={`${label[0]!.toUpperCase()}${label.slice(1)} name`}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onBlur={save}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') {
            setDraft(value);
            setMode(false);
          }
        }}
      />
    );
  }
  return (
    <span className={`inline-rename ${className ?? ''}`}>
      <span className="truncate" title={value}>
        {value}
      </span>
      <button
        type="button"
        className="inline-rename-action"
        aria-label={`Rename ${label} ${value}`}
        title={`Rename ${label}`}
        onClick={(event) => {
          event.stopPropagation();
          setDraft(value);
          setMode(true);
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="m16 3 5 5-12 12-6 1 1-6Z M14 5l5 5" />
        </svg>
      </button>
    </span>
  );
}
