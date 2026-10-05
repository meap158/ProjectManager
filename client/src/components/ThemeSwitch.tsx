import { useEffect, useRef, useState } from 'react';
import {
  followSystemTheme,
  readThemePreference,
  setThemePreference,
  type ThemePreference,
} from '../theme';
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

  return (
    <div className="theme-switch">
      <Dropdown
        label="Colour theme"
        value={preference}
        options={OPTIONS}
        onChange={(value) => {
          setPreference(value);
          setThemePreference(value);
        }}
      />
    </div>
  );
}
