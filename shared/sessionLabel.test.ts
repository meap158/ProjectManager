import { describe, expect, it } from 'vitest';
import { sessionLabel } from './sessionLabel';

describe('sessionLabel (PM-606, PM-607)', () => {
  it('names a session with its number', () => {
    expect(sessionLabel({ id: 138, name: 'Splash' })).toBe('"Splash" (session 138)');
    expect(sessionLabel({ id: 7, name: '  Neon Steps ' })).toBe('"Neon Steps" (session 7)');
  });

  it('falls back to the number only when there is no name to show', () => {
    expect(sessionLabel({ id: 144 })).toBe('session 144');
    expect(sessionLabel({ id: 144, name: null })).toBe('session 144');
    expect(sessionLabel({ id: 144, name: '   ' })).toBe('session 144');
  });
});
