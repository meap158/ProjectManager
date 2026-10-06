import { useEffect, useRef, useState } from 'react';
import {
  followSystemTheme,
  readThemePreference,
  setThemePreference,
  type ThemePreference,
} from '../theme';
import { api } from '../api';
import { Dropdown, type DropdownOption } from './Dropdown';
import { MonitorIcon, MoonIcon, SunIcon } from './icons';

// An icon for each (monitor, sun, moon) so the choice reads at a glance (owner request PM-46).
const OPTIONS: DropdownOption<ThemePreference>[] = [
  {
    value: 'system',
    label: 'System',
    sub: 'Follow your device',
    icon: <MonitorIcon size={14} />,
    title: 'Theme: follow your operating system setting',
  },
  {
    value: 'light',
    label: 'Light',
    sub: 'Always light',
    icon: <SunIcon size={14} />,
    title: 'Theme: always light',
  },
  {
    value: 'dark',
    label: 'Dark',
    sub: 'Always dark',
    icon: <MoonIcon size={14} />,
    title: 'Theme: always dark',
  },
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
