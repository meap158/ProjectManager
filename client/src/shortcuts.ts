import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ShortcutId, ShortcutOverrides } from '../../shared/types';
import { api } from './api';

export type { ShortcutId };

// Keyboard shortcuts (PM-244): actions with a default key, reassigned in Settings. A shortcut
// acts on the selected item by clicking that item's own button (same checks, confirmations
// and disabled states as a click), or runs a handler a component registers (list navigation).
//  - One capture-phase listener on window, so a combo meant for the app never reaches a focused
//    terminal. Plain keys only fire outside text fields and terminals; combos with Ctrl, Alt or
//    Meta also fire from a terminal (a selected session's terminal has focus), never from a
//    text field. Nothing fires while a dialog is open, on key repeat, or mid IME composition.
//  - A combo is consumed whenever its action's scope is on screen, even if the button is
//    missing or disabled (Restart on a stopped session), so it never sometimes reaches the CLI.
//  - Bindings: defaults, plus overrides saved on the server (Settings > Keyboard shortcuts).

export interface ShortcutAction {
  id: ShortcutId;
  label: string;
  group: string;
  default: string;
  /** For actions on the selected item: where that item is on screen (its buttons are inside). */
  scope?: string;
}

/** The selected row of the Agents work list (not the open terminal's own header buttons). */
const SELECTED_WORK = '.work-list > li.selected';

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  {
    id: 'list.next',
    label: 'Select the next session',
    group: 'Agents list',
    default: 'Ctrl+ArrowDown',
  },
  {
    id: 'list.previous',
    label: 'Select the previous session',
    group: 'Agents list',
    default: 'Ctrl+ArrowUp',
  },
  {
    id: 'session.showInPane',
    label: 'Show the selected session in a pane',
    group: 'Selected session',
    default: 'Alt+Shift+P',
    scope: SELECTED_WORK,
  },
  {
    id: 'session.continue',
    label: 'Continue the selected session',
    group: 'Selected session',
    default: 'Alt+Shift+C',
    scope: SELECTED_WORK,
  },
  {
    id: 'session.restart',
    label: 'Restart the selected session',
    group: 'Selected session',
    default: 'Alt+Shift+R',
    scope: SELECTED_WORK,
  },
  {
    id: 'session.toggle',
    label: 'Stop or start the selected session',
    group: 'Selected session',
    default: 'Alt+Shift+S',
    scope: SELECTED_WORK,
  },
  {
    id: 'session.delete',
    label: 'Delete the selected session (asks first)',
    group: 'Selected session',
    default: 'Alt+Shift+D',
    scope: SELECTED_WORK,
  },
  {
    // Ctrl+Shift+\ as in the Claude app (Shift makes the key "|" on a US keyboard).
    id: 'preview.expand',
    label: 'Expand the Preview browser to fill the window, or restore it',
    group: 'Preview',
    default: 'Ctrl+|',
  },
];

const ACTION = new Map(SHORTCUT_ACTIONS.map((a) => [a.id, a]));
const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
const IGNORED_KEYS = new Set([
  'Control',
  'Alt',
  'Shift',
  'Meta',
  'AltGraph',
  'CapsLock',
  'Dead',
  'Unidentified',
  'Process',
]);

/**
 * The combo a key press makes: modifiers in a fixed order, then the key. Letters and digits come
 * from the physical key (Alt/Option change the character), other printable keys from the
 * character with Shift implied ("?" not "Shift+/"), named keys by name. Null for a lone modifier.
 */
export function comboFromEvent(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): string | null {
  if (IGNORED_KEYS.has(e.key)) return null;
  const physical = /^Key([A-Z])$/.exec(e.code)?.[1] ?? /^Digit(\d)$/.exec(e.code)?.[1];
  let key: string;
  let shift = e.shiftKey;
  if (physical) key = physical;
  else if (e.key === ' ') key = 'Space';
  else if (e.key.length === 1) {
    key = e.key.toUpperCase();
    shift = false; // The character already says it ("?", "!").
  } else key = e.key;
  const parts = [
    e.ctrlKey && 'Ctrl',
    e.altKey && 'Alt',
    shift && 'Shift',
    e.metaKey && 'Meta',
  ].filter(Boolean);
  return [...parts, key].join('+');
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const ARROWS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

/** How a combo reads to people: "Alt+Shift+C", on a Mac "⌥⇧C". */
export function formatCombo(combo: string, mac = isMac()): string {
  const parts = combo.split('+');
  const key = parts.pop() ?? '';
  const shown = ARROWS[key] ?? (key === 'Delete' ? 'Del' : key);
  if (mac) {
    const sym: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
    return parts.map((p) => sym[p] ?? p).join('') + shown;
  }
  return [...parts.map((p) => (p === 'Meta' ? 'Win' : p)), shown].join('+');
}

/** The combo in `aria-keyshortcuts` form ("Alt+Shift+C", "Control+ArrowDown"). */
export function ariaCombo(combo: string): string {
  return combo
    .split('+')
    .map((p) => (p === 'Ctrl' ? 'Control' : p))
    .join('+');
}

/** Ctrl, Alt or Meta held (Shift alone types characters, so it doesn't count). */
const hasModifier = (combo: string) =>
  combo
    .split('+')
    .slice(0, -1)
    .some((p) => p !== 'Shift');

/** A combo this app can use: a key with optional modifiers in the fixed order. */
export function validCombo(combo: string): boolean {
  const parts = combo.split('+');
  const key = parts.pop();
  if (!key || key.length > 20) return false;
  let at = -1;
  for (const p of parts) {
    const i = MODIFIERS.indexOf(p as (typeof MODIFIERS)[number]);
    if (i <= at) return false;
    at = i;
  }
  return !IGNORED_KEYS.has(key);
}

// ---- Bindings store ---------------------------------------------------------------------------

let overrides: ShortcutOverrides = {};
let snapshot: Record<ShortcutId, string | null> = computeBindings();
const listeners = new Set<() => void>();

function computeBindings(): Record<ShortcutId, string | null> {
  const out = {} as Record<ShortcutId, string | null>;
  for (const a of SHORTCUT_ACTIONS)
    out[a.id] = a.id in overrides ? (overrides[a.id] ?? null) : a.default;
  return out;
}

function publish(next: ShortcutOverrides) {
  overrides = next;
  snapshot = computeBindings();
  for (const l of listeners) l();
}

export function getBindings(): Record<ShortcutId, string | null> {
  return snapshot;
}

export function useBindings(): Record<ShortcutId, string | null> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

let loaded = false;
/** Loads the saved overrides once (the app shell calls it). */
export function loadShortcuts(): void {
  if (loaded) return;
  loaded = true;
  api.getShortcuts().then(
    (r) => publish(r.overrides),
    () => undefined, // Defaults stay.
  );
}

/** Saves a change: a combo, null to leave the action without one, or undefined for the default. */
export async function setShortcut(id: ShortcutId, combo: string | null | undefined): Promise<void> {
  const next: ShortcutOverrides = { ...overrides };
  if (combo === undefined || combo === ACTION.get(id)?.default) delete next[id];
  else next[id] = combo;
  publish(next);
  const saved = await api.saveShortcuts(next);
  publish(saved.overrides);
}

export async function resetAllShortcuts(): Promise<void> {
  publish({});
  publish((await api.saveShortcuts({})).overrides);
}

/** The action already using a combo, if any (for the Settings clash check). */
export function actionFor(combo: string, bindings = snapshot): ShortcutAction | undefined {
  return SHORTCUT_ACTIONS.find((a) => bindings[a.id] === combo);
}

/** A tooltip with the action's current key appended: "Continue (Alt+Shift+C)". */
export function useShortcutTitle(id: ShortcutId | undefined, title: string): string {
  const bindings = useBindings();
  const combo = id ? bindings[id] : null;
  return combo ? `${title} (${formatCombo(combo)})` : title;
}

/** Props for a button an action clicks: its id for the handler, and the key for screen readers. */
export function useShortcutProps(id: ShortcutId | undefined): Record<string, string> {
  const bindings = useBindings();
  if (!id) return {};
  const combo = bindings[id];
  return combo
    ? { 'data-shortcut': id, 'aria-keyshortcuts': ariaCombo(combo) }
    : { 'data-shortcut': id };
}

// ---- Handler ----------------------------------------------------------------------------------

const handlers = new Map<ShortcutId, () => boolean>();
let recording = false;

/** While Settings records a new combo, shortcuts don't fire. */
export function setRecording(on: boolean): void {
  recording = on;
}

/** Runs `run` for the action while mounted. Return false when it didn't apply (key passes). */
export function useShortcut(id: ShortcutId, run: () => boolean): void {
  const ref = useRef(run);
  useEffect(() => {
    ref.current = run; // The latest closure (selection, items) for the next key press.
  });
  useEffect(() => {
    const call = () => ref.current();
    handlers.set(id, call);
    return () => {
      if (handlers.get(id) === call) handlers.delete(id);
    };
  }, [id]);
}

/** A terminal's keyboard input (xterm types through a hidden textarea of this class). */
const inTerminalInput = (el: Element | null) =>
  el instanceof Element &&
  (el.classList.contains('xterm-helper-textarea') || !!el.closest('.xterm'));

function inTextField(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (inTerminalInput(el)) return false;
  return (
    el.isContentEditable ||
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT'
  );
}

/** What the handler does with a key press (pure, for tests): the action and whether to consume. */
export function decide(
  e: KeyboardEvent,
  doc: Document = document,
): { id: ShortcutId; target: HTMLElement | null } | null {
  if (recording || e.repeat || e.isComposing) return null;
  const combo = comboFromEvent(e);
  if (!combo) return null;
  const action = actionFor(combo);
  if (!action) return null;
  if (doc.querySelector('dialog[open]')) return null;
  const focus = (e.target as Element | null) ?? doc.activeElement;
  if (inTextField(focus)) return null;
  const inTerminal = inTerminalInput(focus);
  if (inTerminal && !hasModifier(combo)) return null;
  if (action.scope) {
    const scope = doc.querySelector(action.scope);
    if (!scope) return null; // Nothing selected here: the key is someone else's.
    const target = scope.querySelector<HTMLElement>(`[data-shortcut="${action.id}"]`);
    return {
      id: action.id,
      target: target && !(target as HTMLButtonElement).disabled ? target : null,
    };
  }
  return handlers.has(action.id) ? { id: action.id, target: null } : null;
}

function onKeyDown(e: KeyboardEvent) {
  const hit = decide(e);
  if (!hit) return;
  const action = ACTION.get(hit.id)!;
  if (!action.scope && !handlers.get(hit.id)?.()) return;
  e.preventDefault();
  e.stopPropagation();
  hit.target?.click();
}

let installed = false;
/** Installs the one listener (the app shell calls it). */
export function installShortcuts(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', onKeyDown, true);
}
