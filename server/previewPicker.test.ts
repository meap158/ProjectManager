import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { proxyPreview } from './preview.js';
import { PICKER_INLINE, PICKER_JS, injectPicker } from './previewPicker.js';

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
