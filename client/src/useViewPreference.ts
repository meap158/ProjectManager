import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/** Remember a non-sensitive view preference in this browser; storage may be unavailable. */
export function useViewPreference<T>(
  key: string,
  fallback: T,
  valid: (value: unknown) => value is T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
      return valid(saved) ? saved : fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Keep the control usable when browser storage is blocked or full.
    }
  }, [key, value]);
  return [value, setValue];
}
