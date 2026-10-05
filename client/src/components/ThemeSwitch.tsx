import { useEffect, useRef, useState } from 'react';
import {
  followSystemTheme,
  readThemePreference,
  setThemePreference,
  type ThemePreference,
} from '../theme';

const OPTIONS: { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'system', label: 'Match system', icon: '◐' },
  { value: 'light', label: 'Light', icon: '☀' },
  { value: 'dark', label: 'Dark', icon: '☾' },
];

/** System / Light / Dark switch for the top bar. */
export function ThemeSwitch() {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);
  const current = useRef(preference);
  useEffect(() => {
    current.current = preference;
  }, [preference]);
  useEffect(() => followSystemTheme(() => current.current), []);

  return (
    <div className="segmented theme-switch" role="radiogroup" aria-label="Colour theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={preference === o.value}
          aria-label={o.label}
          title={o.label}
          className={preference === o.value ? 'is-active' : ''}
          onClick={() => {
            setPreference(o.value);
            setThemePreference(o.value);
          }}
        >
          <span aria-hidden="true">{o.icon}</span>
        </button>
      ))}
    </div>
  );
}
