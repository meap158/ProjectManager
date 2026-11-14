// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  api: {
    getShortcuts: vi.fn(async () => ({ overrides: {} })),
    saveShortcuts: vi.fn(async (overrides: unknown) => ({ overrides })),
  },
}));

const {
  ariaCombo,
  comboFromEvent,
  decide,
  formatCombo,
  getBindings,
  setRecording,
  setShortcut,
  resetAllShortcuts,
  validCombo,
  useShortcut,
  useShortcutFallback,
  onFrameKey,
  SHORTCUT_ACTIONS,
} = await import('./shortcuts');

// Keyboard shortcuts (PM-244): how a key press becomes a combo, how combos read, and when the
// one handler acts, lets the key through, or consumes it.

const key = (init: KeyboardEventInit & { key: string; code?: string }) =>
  new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

afterEach(async () => {
  document.body.innerHTML = '';
  setRecording(false);
  await resetAllShortcuts();
});

describe('combos', () => {
  it('reads letters from the physical key, so Alt/Option characters still match', () => {
    expect(comboFromEvent(key({ key: 'ç', code: 'KeyC', altKey: true, shiftKey: true }))).toBe(
      'Alt+Shift+C',
    );
    expect(comboFromEvent(key({ key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true }))).toBe(
      'Ctrl+ArrowDown',
    );
    expect(comboFromEvent(key({ key: '?', code: 'Slash', shiftKey: true }))).toBe('?');
    expect(comboFromEvent(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toBeNull();
  });

  it('formats for people and screen readers, and validates', () => {
    expect(formatCombo('Alt+Shift+C', false)).toBe('Alt+Shift+C');
    expect(formatCombo('Alt+Shift+C', true)).toBe('⌥⇧C');
    expect(formatCombo('Ctrl+ArrowDown', false)).toBe('Ctrl+↓');
    expect(ariaCombo('Ctrl+ArrowDown')).toBe('Control+ArrowDown');
    expect(validCombo('Alt+Shift+C')).toBe(true);
    expect(validCombo('Shift+Alt+C')).toBe(false);
    expect(validCombo('Ctrl+')).toBe(false);
  });
});

describe('handler', () => {
  const selectedRow = (disabled = false) => {
    document.body.innerHTML = `
      <ul class="work-list"><li class="selected">
        <button data-shortcut="session.continue" ${disabled ? 'disabled' : ''}>Continue</button>
      </li></ul>
      <div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>
      <input id="field" />`;
    return document.querySelector<HTMLButtonElement>('[data-shortcut]')!;
  };
  const press = (target: Element, init: KeyboardEventInit & { key: string; code?: string }) => {
    const e = key(init);
    Object.defineProperty(e, 'target', { value: target });
    return decide(e);
  };
  const continueKey = { key: 'Ç', code: 'KeyC', altKey: true, shiftKey: true };

  it('acts on the selected row, from the page or from its terminal', () => {
    const button = selectedRow();
    expect(press(document.body, continueKey)).toEqual({ id: 'session.continue', target: button });
    expect(press(document.querySelector('.xterm textarea')!, continueKey)?.target).toBe(button);
  });

  it('never fires from a text field, a dialog, a repeat or IME composition', () => {
    selectedRow();
    expect(press(document.getElementById('field')!, continueKey)).toBeNull();
    expect(press(document.body, { ...continueKey, repeat: true })).toBeNull();
    expect(press(document.body, { ...continueKey, isComposing: true })).toBeNull();
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    expect(press(document.body, continueKey)).toBeNull();
  });

  it('lets Ctrl+Arrow reach the project panel instead of the Agents list', () => {
    function ListShortcuts() {
      useShortcut('list.next', () => true);
      useShortcut('list.previous', () => true);
      return null;
    }
    const view = render(<ListShortcuts />);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<aside id="project-panel"><a class="sidebar-item" href="/p/1">One</a></aside>',
    );
    const link = document.querySelector('#project-panel a')!;
    const down = { key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true };
    const up = { key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true };
    expect(press(link, down)).toBeNull();
    expect(press(link, up)).toBeNull();
    expect(press(document.body, down)).toEqual({ id: 'list.next', target: null });
    expect(press(document.body, up)).toEqual({ id: 'list.previous', target: null });
    view.unmount();
  });

  it('lets plain keys reach a terminal, but takes them on the page', async () => {
    const button = selectedRow();
    await setShortcut('session.continue', 'C');
    const plain = { key: 'c', code: 'KeyC' };
    expect(press(document.querySelector('.xterm textarea')!, plain)).toBeNull();
    expect(press(document.body, plain)?.target).toBe(button);
  });

  it('passes the key when nothing is selected, consumes it when the button is unavailable', () => {
    expect(press(document.body, continueKey)).toBeNull();
    selectedRow(true);
    expect(press(document.body, continueKey)).toEqual({ id: 'session.continue', target: null });
  });

  it('is off while Settings records a new key', () => {
    selectedRow();
    setRecording(true);
    expect(press(document.body, continueKey)).toBeNull();
  });
  it('uses saved Continue bindings for orchestrator chat and respects busy fieldsets', async () => {
    document.body.innerHTML = `<section class="orchestrator-terminal">
      <fieldset><button data-shortcut="session.continue">Continue</button></fieldset>
      <div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>
      <textarea id="composer"></textarea></section>`;
    await setShortcut('session.continue', 'Alt+K');
    const combo = { key: 'k', code: 'KeyK', altKey: true };
    const button = document.querySelector('button')!;
    expect(press(document.querySelector('.xterm textarea')!, combo)?.target).toBe(button);
    expect(press(document.querySelector('#composer')!, combo)).toBeNull();
    document.querySelector('fieldset')!.disabled = true;
    expect(press(document.body, combo)).toEqual({ id: 'session.continue', target: null });
    button.remove();
    expect(press(document.body, combo)).toEqual({ id: 'session.continue', target: null });
    expect(press(document.body, { ...combo, repeat: true })).toBeNull();
    expect(press(document.body, { ...combo, isComposing: true })).toBeNull();
  });

  it('keeps only changed keys, and a cleared action has none', async () => {
    await setShortcut('session.restart', 'Alt+Shift+X');
    await setShortcut('session.delete', null);
    expect(getBindings()['session.restart']).toBe('Alt+Shift+X');
    expect(getBindings()['session.delete']).toBeNull();
    await setShortcut('session.restart', undefined);
    expect(getBindings()['session.restart']).toBe('Alt+Shift+R');
  });
});

describe('Preview Expand (as in the Claude app)', () => {
  it('answers Ctrl+Shift+ (the key reads "|" with Shift on a US keyboard)', () => {
    const combo = comboFromEvent({
      key: '|',
      code: 'Backslash',
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      metaKey: false,
    });
    expect(combo).toBe(SHORTCUT_ACTIONS.find((a) => a.id === 'preview.expand')!.default);
  });
});

describe('Ctrl+Up/Down without an Agents list', () => {
  const Probe = ({ run }: { run: () => boolean }) => {
    useShortcutFallback('list.next', run);
    return null;
  };
  const ctrlDown = () => key({ key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true });

  it('is answered by a fallback handler, so the project list can take it', () => {
    const run = vi.fn(() => true);
    const { unmount } = render(<Probe run={run} />);
    expect(decide(ctrlDown())?.id).toBe('list.next');
    unmount();
    expect(decide(ctrlDown())).toBeNull();
  });

  it('runs the action for a key a previewed page hands over, from a frame shown here only', () => {
    const run = vi.fn(() => true);
    render(<Probe run={run} />);
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const message = (data: unknown, source: unknown) =>
      onFrameKey(new MessageEvent('message', { data, source: source as MessageEventSource }));
    const good = { pmPicker: true, type: 'key', key: 'ArrowDown' };
    message(good, frame.contentWindow);
    expect(run).toHaveBeenCalledTimes(1);
    message(good, window); // Not a frame shown here.
    message({ ...good, key: 'ArrowLeft' }, frame.contentWindow);
    message({ ...good, type: 'picked' }, frame.contentWindow);
    message({ ...good, pmPicker: false }, frame.contentWindow);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
