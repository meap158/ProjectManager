// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { sectionHref, sectionOf } from './sectionMemory';

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('section memory (PM-72)', () => {
  it('maps addresses to their nav section', () => {
    expect(sectionOf('/')).toBe('/');
    expect(sectionOf('/board')).toBe('/board');
    expect(sectionOf('/workspace')).toBe('/workspace');
    expect(sectionOf('/orchestrators')).toBe('/orchestrators');
    expect(sectionOf('/projects/3')).toBe('/'); // Project pages belong to Home.
  });

  it("links a section to the address last open in it, never another section's", () => {
    expect(sectionHref('/board')).toBe('/board');
    sessionStorage.setItem(
      'pm-section-paths',
      JSON.stringify({ '/board': '/board?project=4', '/workspace': '/settings' }),
    );
    expect(sectionHref('/board')).toBe('/board?project=4');
    expect(sectionHref('/workspace')).toBe('/workspace'); // A stray value is ignored.
  });
});
