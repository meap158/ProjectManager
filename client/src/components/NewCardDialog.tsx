import { useMemo } from 'react';
import type { Card, CardStatus, ProjectSummary } from '../../../shared/types';
import { CardDialog } from './CardDialog';

/** Creation and editing share the same form, including agent/session controls. */
export function NewCardDialog({
  open,
  status,
  projectId,
  projects,
  onClose,
  onCreated,
  initial,
}: {
  open: boolean;
  status: CardStatus;
  projectId?: number;
  projects?: ProjectSummary[];
  /** Prefilled title and notes, e.g. a gap from Settings > SOPs (PM-322). */
  initial?: { title: string; description: string };
  onClose: () => void;
  onCreated: (card: Card) => void;
}) {
  const draft = useMemo(
    () =>
      open
        ? ({
            id: 0,
            projectId: projectId ?? 0,
            key: '',
            title: initial?.title ?? '',
            description: initial?.description ?? '',
            status,
            position: 0,
            createdAt: '',
            updatedAt: '',
            closedAt: null,
            linkedCommit: null,
          } satisfies Card)
        : null,
    [open, status, projectId, initial],
  );
  return (
    <CardDialog
      card={draft}
      projectId={projectId ?? 0}
      projects={projects}
      creating
      onClose={onClose}
      onSaved={onCreated}
      onDeleted={onClose}
    />
  );
}
