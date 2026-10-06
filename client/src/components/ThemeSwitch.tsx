import { useEffect, useRef, useState } from 'react';
import {
  followSystemTheme,
  readThemePreference,
  setThemePreference,
  type ThemePreference,
} from '../theme';
import { api } from '../api';
import { Dropdown } from './Dropdown';

const OPTIONS: { value: ThemePreference; label: string; title: string }[] = [
  { value: 'system', label: 'Theme: System', title: 'Follow your operating system setting' },
  { value: 'light', label: 'Theme: Light', title: 'Always light' },
  { value: 'dark', label: 'Theme: Dark', title: 'Always dark' },
];

/** Theme menu for the top bar: System (default), Light or Dark. */
export function ThemeSwitch() {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);
  const current = useRef(preference);
  useEffect(() => {
    current.current = preference;
  }, [preference]);
  useEffect(() => followSystemTheme(() => current.current), []);
  // The saved choice on the server wins (survives restarts, port fallback and cleared browser
  // storage); the browser copy only exists so the first paint is already right.
  useEffect(() => {
    let active = true;
    api.getTheme().then(
      ({ theme }) => {
        if (!active) return;
        // Nothing saved yet (first run after this change): keep and upload this browser's choice.
        if (theme === null) {
          api.saveTheme(current.current).catch(() => undefined);
          return;
        }
        if (theme === current.current) return;
        setPreference(theme);
        setThemePreference(theme);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="theme-switch">
      <Dropdown
        label="Colour theme"
        value={preference}
        options={OPTIONS}
        onChange={(value) => {
          setPreference(value);
          setThemePreference(value);
          api.saveTheme(value).catch(() => undefined);
        }}
      />
    </div>
  );
}
