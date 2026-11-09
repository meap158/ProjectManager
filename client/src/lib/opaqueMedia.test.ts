import { describe, expect, it } from 'vitest';
import { downloadManagersPossible } from './opaqueMedia';

const nav = (userAgent: string, maxTouchPoints = 0, mobile?: boolean) => ({
  userAgent,
  maxTouchPoints,
  ...(mobile === undefined ? {} : { userAgentData: { mobile } }),
});

describe('downloadManagersPossible', () => {
  it('is true on desktop browsers, where IDM and the like hook requests', () => {
    expect(
      downloadManagersPossible(
        nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36', 0, false),
      ),
    ).toBe(true);
    expect(
      downloadManagersPossible(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605')),
    ).toBe(true);
  });

  it('is false on phones and tablets, which then stream directly', () => {
    expect(downloadManagersPossible(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile'))).toBe(
      false,
    );
    expect(downloadManagersPossible(nav('Mozilla/5.0 (Linux; Android 15) Chrome/130.0'))).toBe(
      false,
    );
    expect(downloadManagersPossible(nav('Mozilla/5.0 (X11; Linux x86_64)', 5, true))).toBe(false);
    // iPadOS asks for desktop sites with a Mac user agent; only the touch screen gives it away.
    expect(
      downloadManagersPossible(
        nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605', 5),
      ),
    ).toBe(false);
  });
});
