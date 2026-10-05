import { useState } from 'react';

/**
 * A name you can click to rename in place: Enter or leaving the field saves, Escape cancels.
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
    <button
      type="button"
      className={`inline-rename truncate ${className ?? ''}`}
      title={`Rename ${label}`}
      onClick={() => {
        setDraft(value);
        setMode(true);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {value}
    </button>
  );
}
