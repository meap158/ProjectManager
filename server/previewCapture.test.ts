import { describe, expect, it } from 'vitest';
import { normaliseCapture, onTheApp } from './previewCapture.js';

describe('preview capture (PM-311)', () => {
  it("keeps a request on the app: clamped sizes, a path on it, never this app's ports", () => {
    const req = normaliseCapture(
      {
        port: 3000,
        path: '/reports?x=1',
        width: 99999,
        height: 10,
        scrollX: -5,
        scrollY: 1200.6,
        inner: { selector: 'main', top: 40, left: 0 },
        dark: true,
      },
      new Set([5180]),
    );
    expect(req).toEqual({
      port: 3000,
      path: '/reports?x=1',
      width: 2560,
      height: 240,
      scrollX: 0,
      scrollY: 1201,
      inner: { selector: 'main', top: 40, left: 0 },
      dark: true,
      selector: null,
    });
    // The picked element, measured again in the capture so its box lands where it really is.
    expect(
      normaliseCapture({ port: 3000, path: '/', selector: 'main > h2' } as never, new Set())
        .selector,
    ).toBe('main > h2');
    expect(
      normaliseCapture({ port: 3000, path: '/', selector: 'x'.repeat(401) } as never, new Set())
        .selector,
    ).toBeNull();
    expect(
      normaliseCapture({ port: 3000, path: 'http://evil.example/' } as never, new Set()).path,
    ).toBe('/');
    expect(() =>
      normaliseCapture({ port: 3000, path: '//evil.example/' } as never, new Set()),
    ).toThrow();
    expect(() => normaliseCapture({ port: 5180, path: '/' } as never, new Set([5180]))).toThrow();
    expect(() => normaliseCapture({ port: 80, path: '/' } as never, new Set())).toThrow();
  });

  it('lets only the app itself load as a page, so a redirect or link elsewhere is refused', () => {
    expect(onTheApp('http://127.0.0.1:3000/x', 3000)).toBe(true);
    expect(onTheApp('http://localhost:3000/', 3000)).toBe(true);
    expect(onTheApp('about:blank', 3000)).toBe(true);
    expect(onTheApp('http://127.0.0.1:3001/', 3000)).toBe(false);
    expect(onTheApp('https://evil.example/', 3000)).toBe(false);
    expect(onTheApp('http://10.0.0.5:3000/', 3000)).toBe(false);
    expect(onTheApp('file:///C:/secret.txt', 3000)).toBe(false);
  });
});
