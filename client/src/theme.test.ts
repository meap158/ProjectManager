// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { followSystemTheme, readThemePreference, setThemePreference } from './theme';

let osDark = false;
const listeners: (() => void)[] = [];
vi.stubGlobal('matchMedia', () => ({
  get matches() {
    return osDark;
  },
  addEventListener: (_: string, cb: () => void) => listeners.push(cb),
  removeEventListener: () => undefined,
}));

afterEach(() => {
  localStorage.clear();
  osDark = false;
  listeners.length = 0;
});

const theme = () => document.documentElement.dataset.theme;

describe('theme', () => {
  it('applies and remembers an explicit choice', () => {
    setThemePreference('dark');
    expect(theme()).toBe('dark');
    expect(readThemePreference()).toBe('dark');
    setThemePreference('light');
    expect(theme()).toBe('light');
  });

  it('"system" follows the OS, live, and is the default', () => {
    expect(readThemePreference()).toBe('system');
    osDark = true;
    setThemePreference('system');
    expect(theme()).toBe('dark');
    expect(localStorage.getItem('pm-theme')).toBeNull();

    followSystemTheme(() => 'system');
    osDark = false;
    listeners.forEach((cb) => cb());
    expect(theme()).toBe('light');
  });

  it('an explicit choice ignores OS changes', () => {
    setThemePreference('dark');
    followSystemTheme(() => 'dark');
    osDark = false;
    listeners.forEach((cb) => cb());
    expect(theme()).toBe('dark');
  });
});
