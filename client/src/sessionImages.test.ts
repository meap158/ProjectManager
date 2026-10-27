// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { clipboardImage } from './sessionImages';

const original = navigator.clipboard;
afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: original, configurable: true });
});
const clipboard = (read?: () => Promise<unknown>) =>
  Object.defineProperty(navigator, 'clipboard', {
    value: read ? { read } : {},
    configurable: true,
  });

it('reads the image on this device’s clipboard (Alt+V away from the computer)', async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
  clipboard(async () => [
    { types: ['text/plain'], getType: vi.fn() },
    { types: ['text/html', 'image/jpeg'], getType: async () => blob },
  ]);
  const file = await clipboardImage();
  expect(file).toBeInstanceOf(File);
  expect((file as File).name).toBe('image.jpg');
  expect((file as File).type).toBe('image/jpeg');
});

it('tells no image apart from a clipboard the browser cannot read', async () => {
  clipboard(async () => [{ types: ['text/plain'], getType: vi.fn() }]);
  expect(await clipboardImage()).toBe('none');
  clipboard(() => Promise.reject(new DOMException('Denied', 'NotAllowedError')));
  expect(await clipboardImage()).toBe('unavailable');
  clipboard(); // Plain-http LAN pages have no clipboard.read.
  expect(await clipboardImage()).toBe('unavailable');
});
