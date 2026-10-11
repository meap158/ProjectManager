import type { Db } from '../db.js';
import type { ProjectSummary } from '../../shared/types.js';
import { projectAttention } from '../../shared/projectAttention.js';
import {
  getSetting,
  setSetting,
  deleteSetting,
  insertCard,
  getCard,
  updateCard,
} from '../store.js';

export interface PruneAttentionResult {
  prunedCardId: number | null;
  cleared: boolean;
  remainingKinds: string[];
}

export function getDismissedAttention(db: Db, projectId: number): string[] {
  return (
    getSetting<{ kinds: string[] }>(db, `orchestrator-dismissed-attention:${projectId}`)?.kinds ??
    []
  );
}

export function dismissProjectAttention(
  db: Db,
  projectId: number,
  kinds?: string[],
): { dismissed: string[]; prunedCardId: number | null } {
  const current = getDismissedAttention(db, projectId);
  const nextKinds = Array.from(
    new Set([
      ...current,
      ...(kinds && kinds.length
        ? kinds
        : ['Folder missing', 'Scan failed', 'Stale', 'Uncommitted', 'Unpushed']),
    ]),
  );
  setSetting(db, `orchestrator-dismissed-attention:${projectId}`, {
    kinds: nextKinds,
    at: new Date().toISOString(),
  });

  // If there is an active attention card whose items are all dismissed/resolved, mark it done.
  const key = `orchestrator-attention:${projectId}`;
  const previous = getSetting<{ cardId: number; kinds: string[] }>(db, key);
  let prunedCardId: number | null = null;
  if (previous?.cardId) {
    const card = getCard(db, previous.cardId);
    if (card && card.status !== 'done') {
      updateCard(db, card.id, {
        status: 'done',
        description: `${card.description}\n\n[Pruned: Dashboard attention dismissed by user.]`,
      });
      setSetting(db, key, { cardId: card.id, kinds: [] });
      prunedCardId = card.id;
    }
  }
  return { dismissed: nextKinds, prunedCardId };
}

export function clearDismissedAttention(db: Db, projectId: number): void {
  deleteSetting(db, `orchestrator-dismissed-attention:${projectId}`);
}

/** Prunes resolved or obsolete Dashboard attention follow-up cards. */
export function pruneProjectAttention(db: Db, project: ProjectSummary): PruneAttentionResult {
  const key = `orchestrator-attention:${project.id}`;
  const dismissed = getDismissedAttention(db, project.id);
  const items = projectAttention(project, Date.now(), dismissed);
  const previous = getSetting<{ cardId: number; kinds: string[] }>(db, key);

  if (!items.length) {
    let prunedCardId: number | null = null;
    if (previous?.cardId) {
      const card = getCard(db, previous.cardId);
      if (card && card.status !== 'done') {
        updateCard(db, card.id, {
          status: 'done',
          description: `${card.description}\n\n[Auto-pruned: All Dashboard attention items for ${project.name} have been resolved.]`,
        });
        prunedCardId = card.id;
      }
      setSetting(db, key, { cardId: previous.cardId, kinds: [] });
    }
    return { prunedCardId, cleared: true, remainingKinds: [] };
  }

  const kinds = items.map((i) => i.kind);
  if (previous && previous.kinds.some((k) => !kinds.includes(k))) {
    setSetting(db, key, { ...previous, kinds });
  }
  return { prunedCardId: null, cleared: false, remainingKinds: kinds };
}

/** One card per attention episode, including across restarts and multiple masters. */
export function followProjectAttention(db: Db, project: ProjectSummary): number | null {
  const key = `orchestrator-attention:${project.id}`;
  const dismissed = getDismissedAttention(db, project.id);
  const items = projectAttention(project, Date.now(), dismissed);
  const previous = getSetting<{ cardId: number; kinds: string[] }>(db, key);
  if (!items.length) {
    pruneProjectAttention(db, project);
    return null;
  }
  const kinds = items.map((i) => i.kind);
  // A completed/deleted follow-up is not recreated on every tick while signals persist.
  if (previous && kinds.every((kind) => previous.kinds.includes(kind))) return null;
  const previousCard = previous ? getCard(db, previous.cardId) : null;
  if (previousCard && previousCard.status !== 'done') {
    updateCard(db, previousCard.id, {
      description: `${previousCard.description}\n\nNew Dashboard attention:\n${items
        .filter((i) => !previous!.kinds.includes(i.kind))
        .map((i) => `- ${i.kind}: ${i.detail}`)
        .join('\n')}`,
    });
    setSetting(db, key, { cardId: previousCard.id, kinds });
    return null;
  }
  const card = insertCard(db, project.id, {
    title: 'Follow up Dashboard attention',
    description: `Inspect the pending Dashboard items for ${project.name}:\n${items.map((i) => `- ${i.kind}: ${i.detail}`).join('\n')}\n\nRecheck current state before acting. Preserve existing work and coordinate with any active workers. Diagnose and validate pending changes, identify what remains, and report concrete next steps. Do not discard changes or force-push. Commit or push only when the project instructions authorize it and validation succeeds.`,
    status: project.missing ? 'review' : 'todo',
  });
  setSetting(db, key, { cardId: card.id, kinds });
  return card.id;
}
