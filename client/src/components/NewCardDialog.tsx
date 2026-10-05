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
}: {
  open: boolean;
  status: CardStatus;
  projectId?: number;
  projects?: ProjectSummary[];
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
            title: '',
            description: '',
            status,
            position: 0,
            createdAt: '',
            updatedAt: '',
            closedAt: null,
            linkedCommit: null,
          } satisfies Card)
        : null,
    [open, status, projectId],
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
