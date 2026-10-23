// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const saveShortcuts = vi.fn(async (overrides: unknown) => ({ overrides }));
vi.mock('../api', () => ({
  api: { getShortcuts: vi.fn(async () => ({ overrides: {} })), saveShortcuts },
}));

const { KeyboardShortcutsPanel } = await import('./KeyboardShortcutsPanel');
const { getBindings, resetAllShortcuts } = await import('../shortcuts');

// Settings > Keyboard shortcuts (PM-244): record a new key, refuse one in use, clear and reset.

afterEach(async () => {
  cleanup();
  await resetAllShortcuts();
  saveShortcuts.mockClear();
});

const change = (label: string) =>
  fireEvent.click(screen.getByRole('button', { name: `Change the shortcut for ${label}` }));
const recorder = () => screen.getByRole('button', { name: /Press the new keys/ });

describe('KeyboardShortcutsPanel', () => {
  it('records a new key and saves only the change', async () => {
    render(<KeyboardShortcutsPanel onError={() => {}} />);
    change('Continue the selected session');
    fireEvent.keyDown(recorder(), { key: 'Alt', code: 'AltLeft', altKey: true });
    expect(recorder()).toBeTruthy(); // A modifier alone keeps listening.
    fireEvent.keyDown(recorder(), { key: 'k', code: 'KeyK', altKey: true });
    await waitFor(() => expect(getBindings()['session.continue']).toBe('Alt+K'));
    expect(saveShortcuts).toHaveBeenLastCalledWith({ 'session.continue': 'Alt+K' });
    expect(screen.getByText('Alt+K')).toBeTruthy();
  });

  it('refuses a key another action uses, and Escape cancels', () => {
    render(<KeyboardShortcutsPanel onError={() => {}} />);
    change('Continue the selected session');
    fireEvent.keyDown(recorder(), { key: 'R', code: 'KeyR', altKey: true, shiftKey: true });
    expect(screen.getByRole('alert').textContent).toMatch(/already used by “Restart the selected/);
    fireEvent.keyDown(recorder(), { key: 'Escape', code: 'Escape' });
    expect(screen.queryByRole('button', { name: /Press the new keys/ })).toBeNull();
    expect(getBindings()['session.continue']).toBe('Alt+Shift+C');
    expect(saveShortcuts).not.toHaveBeenCalled();
  });

  it('clears an action, and resets it to its default', async () => {
    render(<KeyboardShortcutsPanel onError={() => {}} />);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove the shortcut for Delete the selected session (asks first)',
      }),
    );
    await waitFor(() => expect(getBindings()['session.delete']).toBeNull());
    fireEvent.click(
      screen.getByRole('button', { name: /Reset the shortcut for Delete the selected/ }),
    );
    await waitFor(() => expect(getBindings()['session.delete']).toBe('Alt+Shift+D'));
  });
});
