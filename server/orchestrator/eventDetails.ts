import type { Db } from '../db.js';
import { getSetting, setSetting } from '../store.js';

/*
 * Full texts behind Activity entries (PM-452). An event's message is a one-line summary, cut to
 * fit the list; what the orchestrator actually wrote (a message to a session, a goal note, a git
 * command) is kept here, outside the event history that is rewritten on every event, and the
 * event carries its detailId. The Activity modal reads it on demand.
 */

const KEY = 'orchestrator-event-details';
/** Details kept; older ones go first (their events usually have left the history too). */
export const KEEP_DETAILS = 200;
export const MAX_DETAIL = 4000;

interface Detail {
  id: number;
  text: string;
}

export function addEventDetail(db: Db, text: string): number {
  const list = getSetting<Detail[]>(db, KEY) ?? [];
  const id = (list.at(-1)?.id ?? 0) + 1;
  setSetting(db, KEY, [...list, { id, text: text.slice(0, MAX_DETAIL) }].slice(-KEEP_DETAILS));
  return id;
}

export function eventDetail(db: Db, id: number): string | null {
  return (getSetting<Detail[]>(db, KEY) ?? []).find((d) => d.id === id)?.text ?? null;
}
