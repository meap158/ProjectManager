import { describe, expect, it } from 'vitest';
import { hasImageSize, readImageSize } from './imageSize.js';

// Picture sizes from file headers (PM-286): the formats a project's assets use, read without a decode.

const be16 = (n: number) => Buffer.from([n >> 8, n & 255]);
const le16 = (n: number) => Buffer.from([n & 255, n >> 8]);
const le24 = (n: number) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255]);

describe('readImageSize', () => {
  it('reads a PNG from its IHDR chunk', () => {
    const be32 = (n: number) => Buffer.from([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      be32(13),
      Buffer.from('IHDR'),
      be32(37),
      be32(21),
      Buffer.alloc(9),
    ]);
    expect(readImageSize(png, 'png')).toEqual({ width: 37, height: 21 });
    // The extension's case does not matter.
    expect(readImageSize(png, 'PNG')).toEqual({ width: 37, height: 21 });
  });

  it('reads a GIF', () => {
    const gif = Buffer.concat([Buffer.from('GIF89a'), le16(640), le16(480), Buffer.alloc(8)]);
    expect(readImageSize(gif, 'gif')).toEqual({ width: 640, height: 480 });
  });

  it('reads a BMP, bottom-up or top-down', () => {
    const header = (height: number) => {
      const b = Buffer.alloc(30);
      b.write('BM', 0, 'ascii');
      b.writeInt32LE(100, 18);
      b.writeInt32LE(height, 22);
      return b;
    };
    expect(readImageSize(header(50), 'bmp')).toEqual({ width: 100, height: 50 });
    expect(readImageSize(header(-50), 'bmp')).toEqual({ width: 100, height: 50 });
  });

  it('reads a JPEG past its application segments, and ignores the table and arithmetic markers', () => {
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), be16(10), Buffer.alloc(8)]);
    const dht = Buffer.concat([Buffer.from([0xff, 0xc4]), be16(6), Buffer.alloc(4)]);
    const sof = Buffer.concat([
      Buffer.from([0xff, 0xc2]), // A progressive frame.
      be16(17),
      Buffer.from([8]),
      be16(768),
      be16(1024),
      Buffer.alloc(10),
    ]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, dht, sof]);
    expect(readImageSize(jpeg, 'jpg')).toEqual({ width: 1024, height: 768 });
    expect(readImageSize(jpeg, 'jpeg')).toEqual({ width: 1024, height: 768 });
  });

  it('reads the three kinds of WebP', () => {
    const riff = (chunk: string, body: Buffer) =>
      Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.alloc(4),
        Buffer.from('WEBP'),
        Buffer.from(chunk),
        Buffer.alloc(4),
        body,
      ]);
    // Extended: the canvas size minus one, in 24 bits each, after 4 bytes of flags.
    const x = riff('VP8X', Buffer.concat([Buffer.alloc(4), le24(799), le24(599), Buffer.alloc(4)]));
    expect(readImageSize(x, 'webp')).toEqual({ width: 800, height: 600 });
    // Lossless: a signature byte, then 14 bits each of width and height minus one.
    const bits = ((299 & 0x3fff) | ((199 & 0x3fff) << 14)) >>> 0;
    const l = Buffer.alloc(5);
    l[0] = 0x2f;
    l.writeUInt32LE(bits, 1);
    expect(readImageSize(riff('VP8L', Buffer.concat([l, Buffer.alloc(8)])), 'webp')).toEqual({
      width: 300,
      height: 200,
    });
    // Lossy: a 3-byte frame tag, the start code, then the size.
    const lossy = Buffer.concat([
      Buffer.alloc(3),
      Buffer.from([0x9d, 0x01, 0x2a]),
      le16(320),
      le16(240),
      Buffer.alloc(8),
    ]);
    expect(readImageSize(riff('VP8 ', lossy), 'webp')).toEqual({ width: 320, height: 240 });
  });

  it('reads an SVG from its size, or the proportions of its viewBox', () => {
    expect(
      readImageSize(Buffer.from('<svg width="120px" height="80" xmlns="x"></svg>'), 'svg'),
    ).toEqual({ width: 120, height: 80 });
    expect(
      readImageSize(Buffer.from("<?xml version='1.0'?><svg viewBox='0 0 24 16'></svg>"), 'svg'),
    ).toEqual({ width: 24, height: 16 });
    expect(readImageSize(Buffer.from('<svg width="100%" height="100%"></svg>'), 'svg')).toBeNull();
    expect(readImageSize(Buffer.from('<html></html>'), 'svg')).toBeNull();
  });

  it('gives null, never an error, for the wrong format, a truncated header or an unknown type', () => {
    expect(readImageSize(Buffer.from('not an image at all, just text'), 'png')).toBeNull();
    expect(readImageSize(Buffer.from([0x89, 0x50]), 'png')).toBeNull();
    expect(readImageSize(Buffer.from([0xff, 0xd8, 0xff]), 'jpg')).toBeNull();
    expect(readImageSize(Buffer.alloc(0), 'webp')).toBeNull();
    expect(readImageSize(Buffer.alloc(40), 'tiff')).toBeNull();
    // An absurd size is a damaged header, not a picture.
    const huge = Buffer.concat([Buffer.from('GIF89a'), le16(65535), le16(65535)]);
    expect(readImageSize(huge, 'gif')).toEqual({ width: 65535, height: 65535 });
  });

  it('knows which extensions it can read', () => {
    for (const ext of ['png', 'JPG', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])
      expect(hasImageSize(ext)).toBe(true);
    for (const ext of ['md', 'ico', 'avif', 'psd', '']) expect(hasImageSize(ext)).toBe(false);
  });
});
