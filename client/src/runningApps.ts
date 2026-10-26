import { useSyncExternalStore } from 'react';
import type { LocalApp } from '../../shared/types';
import { api } from './api';
import { serialPoll } from './lib/serialPoll';

// Web apps running on this computer, by the project they were started from (Preview's detection,
// PM-297). One poll for the whole app however many places show it (the sidebar's globes, a
// project page's header), every 15s and paused while the tab is hidden.

type ByProject = ReadonlyMap<number, LocalApp[]>;
const EMPTY: ByProject = new Map();
let current: ByProject = EMPTY;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

/** Same projects with the same ports: keeps the previous map, so nothing re-renders. */
function sameApps(a: ByProject, b: ByProject): boolean {
  if (a.size !== b.size) return false;
  for (const [id, apps] of b) {
    const old = a.get(id);
    if (!old || old.map((x) => x.port).join() !== apps.map((x) => x.port).join()) return false;
  }
  return true;
}

function load(): Promise<void> {
  return api.localApps().then(
    ({ apps }) => {
      const next = new Map<number, LocalApp[]>();
      for (const app of apps) {
        if (!app.web || app.projectId == null) continue;
        next.set(app.projectId, [...(next.get(app.projectId) ?? []), app]);
      }
      if (sameApps(current, next)) return;
      current = next;
      for (const listener of listeners) listener();
    },
    () => undefined, // A convenience: pages work without it.
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  stop ??= serialPoll(load, 15_000, { pauseWhenHidden: true });
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
    }
  };
}

/** The running web apps of every project. */
export function useRunningApps(): ByProject {
  return useSyncExternalStore(subscribe, () => current);
}

/** "App running: localhost:3000" — what a running-app globe says. */
export function runningAppsLabel(apps: LocalApp[]): string {
  const where = apps.map((a) => `localhost:${a.port}`).join(', ');
  return apps.length === 1 ? `App running: ${where}` : `${apps.length} apps running: ${where}`;
}

/** Forgets the shared state (tests). */
export function resetRunningApps(): void {
  stop?.();
  stop = null;
  current = EMPTY;
  listeners.clear();
}
