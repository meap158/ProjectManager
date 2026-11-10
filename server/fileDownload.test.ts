import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { attachmentHeader, streamDownload } from './fileDownload.js';

// Download any project file (PM-652): an inert attachment, inside the project only.

const root = mkdtempSync(path.join(os.tmpdir(), 'pm-download-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('streamDownload', () => {
  it('streams the file as an inert attachment with its name', async () => {
    writeFileSync(path.join(root, 'page.html'), '<script>alert(1)</script>');
    const response = await streamDownload(root, 'page.html');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toContain('filename="page.html"');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe('<script>alert(1)</script>');
  });

  it('refuses folders and paths outside the project', async () => {
    await expect(streamDownload(root, '.')).rejects.toThrow();
    await expect(streamDownload(root, '../elsewhere.txt')).rejects.toThrow();
  });

  it('keeps non-ASCII names exact and the quoted fallback safe', () => {
    const header = attachmentHeader('báo "cáo".mp4');
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('báo "cáo".mp4')}`);
    expect(header).toContain('filename="b_o _c_o_.mp4"');
  });
});
