import { expect, it } from 'vitest';
import { openDb } from '../db.js';
import { listCards } from '../store.js';
import type { ProjectSummary } from '../../shared/types.js';
import {
  dismissProjectAttention,
  followProjectAttention,
  pruneProjectAttention,
} from './attention.js';

it('deduplicates attention across ticks and allows a new episode after resolution', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (1, ?, ?, ?)').run(
    'Test',
    '.',
    new Date().toISOString(),
  );
  const project = {
    id: 1,
    name: 'Test',
    path: '.',
    missing: false,
    scan: { status: 'idle' },
    git: { dirtyFiles: 3, ahead: 2 },
  } as ProjectSummary;
  try {
    const id = followProjectAttention(db, project);
    expect(id).not.toBeNull();
    expect(followProjectAttention(db, project)).toBeNull();
    expect(listCards(db, 1)).toHaveLength(1);
    expect(listCards(db, 1)[0]?.description).toContain('Uncommitted');
    expect(listCards(db, 1)[0]?.description).toContain('Unpushed');
    db.prepare("UPDATE cards SET status = 'done' WHERE id = ?").run(id!);
    expect(followProjectAttention(db, project)).toBeNull();
    followProjectAttention(db, { ...project, git: null });
    expect(followProjectAttention(db, project)).not.toBeNull();
    expect(listCards(db, 1)).toHaveLength(2);
  } finally {
    db.close();
  }
});

it('prunes resolved attention follow-up cards when items clear', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (1, ?, ?, ?)').run(
    'AutoPrune',
    '.',
    new Date().toISOString(),
  );
  const project = {
    id: 1,
    name: 'AutoPrune',
    path: '.',
    missing: false,
    scan: { status: 'idle' },
    git: { dirtyFiles: 2, ahead: 0 },
  } as ProjectSummary;
  try {
    const cardId = followProjectAttention(db, project);
    expect(cardId).not.toBeNull();
    expect(listCards(db, 1)[0]?.status).toBe('todo');

    // Issues clear (git is now clean)
    const cleanProject = { ...project, git: { dirtyFiles: 0, ahead: 0 } } as ProjectSummary;
    const pruneResult = pruneProjectAttention(db, cleanProject);
    expect(pruneResult.prunedCardId).toBe(cardId);
    expect(pruneResult.cleared).toBe(true);

    const updated = listCards(db, 1)[0]!;
    expect(updated.status).toBe('done');
    expect(updated.description).toContain('Auto-pruned');
  } finally {
    db.close();
  }
});

it('dismisses attention items and prunes active attention cards', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (1, ?, ?, ?)').run(
    'Dismiss',
    '.',
    new Date().toISOString(),
  );
  const project = {
    id: 1,
    name: 'Dismiss',
    path: '.',
    missing: false,
    scan: { status: 'idle' },
    git: { dirtyFiles: 5, ahead: 1 },
  } as ProjectSummary;
  try {
    const cardId = followProjectAttention(db, project);
    expect(cardId).not.toBeNull();

    const { dismissed, prunedCardId } = dismissProjectAttention(db, 1);
    expect(dismissed).toContain('Uncommitted');
    expect(prunedCardId).toBe(cardId);
    expect(listCards(db, 1)[0]?.status).toBe('done');

    // Following attention now sees 0 items because they were dismissed
    expect(followProjectAttention(db, project)).toBeNull();
  } finally {
    db.close();
  }
});

it('keeps missing-folder attention in review instead of dispatching into an invalid cwd', () => {
  const db = openDb(':memory:');
  db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (1, ?, ?, ?)').run(
    'Missing',
    '.',
    new Date().toISOString(),
  );
  try {
    followProjectAttention(db, {
      id: 1,
      name: 'Missing',
      path: 'missing',
      missing: true,
      scan: { status: 'idle' },
      git: null,
    } as ProjectSummary);
    expect(listCards(db, 1)[0]?.status).toBe('review');
  } finally {
    db.close();
  }
});
