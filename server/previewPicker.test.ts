import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { proxyPreview } from './preview.js';
import { PICKER_INLINE, PICKER_JS, injectPicker, pickerCsp, pickerTag } from './previewPicker.js';

describe('injectPicker (PM-311)', () => {
  it('goes right after <head>, else after <html>, else first', () => {
    expect(injectPicker('<html><head lang="x"><title>t</title></head>', '<s>')).toBe(
      '<html><head lang="x"><s><title>t</title></head>',
    );
    expect(injectPicker('<html><body>b</body></html>', '<s>')).toBe(
      '<html><s><body>b</body></html>',
    );
    expect(injectPicker('<p>bare</p>', '<s>')).toBe('<s><p>bare</p>');
  });

  it('stays inert: it only acts on start/stop messages from the window that frames it', () => {
    expect(PICKER_JS).toContain('window.parent === window');
    expect(PICKER_JS).toContain('e.source !== window.parent');
    expect(PICKER_JS).not.toContain('</script>');
  });

  it('is added inline by the path-mode proxy, to HTML only', async () => {
    const app = http.createServer((req, res) => {
      if (req.url === '/data') res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      else res.writeHead(200, { 'content-type': 'text/html' }).end('<head></head><body>hi</body>');
    });
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const port = (app.address() as AddressInfo).port;
    try {
      const page = await proxyPreview(new Request('http://x/'), port, '/', '');
      expect(await page.text()).toBe(`<head>${PICKER_INLINE}</head><body>hi</body>`);
      const data = await proxyPreview(new Request('http://x/'), port, '/data', '');
      expect(await data.text()).toBe('{}');
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  });
});

describe('the picker under a strict page policy (Next.js nonces)', () => {
  const fresh = () => 'OURS1234';
  it("reuses the page's nonce where 'strict-dynamic' would block 'self'", () => {
    const csp = "default-src 'self'; script-src 'self' 'nonce-PAGE5678' 'strict-dynamic'";
    expect(pickerCsp(csp, fresh)).toEqual({ csp, nonce: 'PAGE5678' });
    expect(pickerTag('PAGE5678')).toBe(
      '<script src="/__pm-picker.js" nonce="PAGE5678" data-pm-picker></script>',
    );
  });
  it('adds a nonce of its own when the policy has none (hashes only), and leaves easy policies alone', () => {
    expect(pickerCsp("script-src 'sha256-abc' 'strict-dynamic'", fresh)).toEqual({
      csp: "script-src 'sha256-abc' 'strict-dynamic' 'nonce-OURS1234'",
      nonce: 'OURS1234',
    });
    expect(pickerCsp("default-src 'self' 'strict-dynamic'", fresh).csp).toBe(
      "default-src 'self' 'strict-dynamic'; script-src 'self' 'strict-dynamic' 'nonce-OURS1234'",
    );
    expect(pickerCsp("default-src 'self'", fresh)).toEqual({
      csp: "default-src 'self'",
      nonce: null,
    });
    // A nonce that could break out of the attribute is never written.
    expect(pickerTag('x" onload="evil')).not.toContain('onload');
  });
});
