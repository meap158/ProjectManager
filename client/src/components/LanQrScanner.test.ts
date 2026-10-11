import { expect, it } from 'vitest';
import { pairingQrUrl, decodePairingPixels } from './LanQrScanner';
import QRCode from 'qrcode';
it('decodes a real generated pairing QR entirely on-device', async () => {
  const url = 'http://meap.local:5180/#pair=ABCD';
  const qr = QRCode.create(url);
  const width = (qr.modules.size + 8) * 4;
  const pixels = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const row = Math.floor(y / 4) - 4;
      const col = Math.floor(x / 4) - 4;
      const dark =
        row >= 0 &&
        col >= 0 &&
        row < qr.modules.size &&
        col < qr.modules.size &&
        qr.modules.get(row, col);
      const offset = (y * width + x) * 4;
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = dark ? 0 : 255;
      pixels[offset + 3] = 255;
    }
  expect(await decodePairingPixels(pixels, width, width)).toBe(url);
});
it('accepts private-network pairing links', () => {
  expect(pairingQrUrl('http://meap.local:5180/#pair=ABCD')).toBe(
    'http://meap.local:5180/#pair=ABCD',
  );
  expect(pairingQrUrl('http://192.168.1.3:5180/#pair=ABCD')).not.toBeNull();
});
it('rejects unrelated QR links, credentials and remote destinations', () => {
  for (const url of [
    'javascript:alert(1)',
    'http://example.com/#pair=ABCD',
    'http://user:pass@host.local/#pair=ABCD',
    'http://host.local/other#pair=ABCD',
    'http://host.local/?x=1#pair=ABCD',
    'http://host.local/#other=ABCD',
  ])
    expect(pairingQrUrl(url)).toBeNull();
});
