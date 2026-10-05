import { describe, expect, it } from 'vitest';
import { MAX_SESSION_INPUT_CHARS, splitSessionInput } from './sessionInput';

describe('splitSessionInput', () => {
  it('keeps small input in one chunk', () => {
    expect(splitSessionInput('hello')).toEqual(['hello']);
  });

  it('returns no chunks for empty input', () => {
    expect(splitSessionInput('')).toEqual([]);
  });

  it('splits large pastes into chunks under the server cap', () => {
    const data = 'x'.repeat(MAX_SESSION_INPUT_CHARS * 2 + 100);
    const parts = splitSessionInput(data);
    expect(parts.length).toBe(3);
    expect(parts.join('')).toBe(data);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_SESSION_INPUT_CHARS);
  });

  it('never splits a surrogate pair across two writes', () => {
    const emoji = '😀'; // A surrogate pair in UTF-16.
    const data = 'a'.repeat(MAX_SESSION_INPUT_CHARS - 1) + emoji + 'b'.repeat(10);
    const parts = splitSessionInput(data);
    expect(parts.join('')).toBe(data);
    expect(parts[0]).toBe('a'.repeat(MAX_SESSION_INPUT_CHARS - 1));
    expect(parts[1]?.startsWith(emoji)).toBe(true);
  });
});
