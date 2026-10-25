// Picture sizes read from the start of a file, for the folder previewer (PM-286). Only the header
// is looked at (never a full decode), so a folder of large pictures costs a few KB per file. A
// format it does not know, or a header it cannot read, gives null: the previewer then shows no size.

export interface ImageSize {
  width: number;
  height: number;
}

/** How much of the start of a file is read: enough for every header, and for a JPEG's first frame. */
export const HEADER_BYTES = 128 * 1024;

const ok = (width: number, height: number): ImageSize | null =>
  Number.isInteger(width) &&
  Number.isInteger(height) &&
  width > 0 &&
  height > 0 &&
  width < 1e6 &&
  height < 1e6
    ? { width, height }
    : null;

function png(b: Buffer): ImageSize | null {
  // 8-byte signature, then the IHDR chunk: length, "IHDR", width, height.
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR')
    return null;
  return ok(b.readUInt32BE(16), b.readUInt32BE(20));
}

function gif(b: Buffer): ImageSize | null {
  if (b.length < 10 || !/^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return null;
  return ok(b.readUInt16LE(6), b.readUInt16LE(8));
}

function bmp(b: Buffer): ImageSize | null {
  if (b.length < 26 || b.toString('ascii', 0, 2) !== 'BM') return null;
  // BITMAPINFOHEADER: signed width and height (height is negative for a top-down bitmap).
  return ok(Math.abs(b.readInt32LE(18)), Math.abs(b.readInt32LE(22)));
}

function jpeg(b: Buffer): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at++; // Fill byte.
      continue;
    }
    // Markers without a length: start of image, restart markers, TEM.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = b.readUInt16BE(at + 2);
    // A start-of-frame marker (all of C0 to CF except the table and arithmetic ones) holds the size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (at + 9 > b.length) return null;
      return ok(b.readUInt16BE(at + 7), b.readUInt16BE(at + 5));
    }
    if (marker === 0xda || length < 2) return null; // Image data starts: no frame header found.
    at += 2 + length;
  }
  return null;
}

function webp(b: Buffer): ImageSize | null {
  if (
    b.length < 30 ||
    b.toString('ascii', 0, 4) !== 'RIFF' ||
    b.toString('ascii', 8, 12) !== 'WEBP'
  )
    return null;
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8X') return ok(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
  if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (kind === 'VP8 ') {
    // Lossy: a frame tag, the 9d 01 2a start code, then 14-bit width and height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  }
  return null;
}

/** An SVG's own size: its width and height in pixels, else the proportions of its viewBox. */
function svg(b: Buffer): ImageSize | null {
  const head = b.toString('utf8', 0, Math.min(b.length, 8192));
  const tag = /<svg\b[^>]*>/i.exec(head)?.[0];
  if (!tag) return null;
  const attribute = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag)?.[1];
  const pixels = (value: string | undefined) => {
    const match = value ? /^\s*([\d.]+)\s*(px)?\s*$/i.exec(value) : null;
    return match ? Math.round(Number(match[1])) : null;
  };
  const width = pixels(attribute('width'));
  const height = pixels(attribute('height'));
  if (width && height) return ok(width, height);
  const box = attribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box && box.length === 4 && box.every(Number.isFinite))
    return ok(Math.round(box[2]!), Math.round(box[3]!));
  return null;
}

const READERS: Record<string, (b: Buffer) => ImageSize | null> = {
  png,
  gif,
  bmp,
  jpg: jpeg,
  jpeg,
  webp,
  svg,
};

/** Whether a file extension is one whose size can be read. */
export const hasImageSize = (extension: string): boolean => extension.toLowerCase() in READERS;

/** The pixel size of a picture from the start of its file, or null. Never throws. */
export function readImageSize(head: Buffer, extension: string): ImageSize | null {
  try {
    return READERS[extension.toLowerCase()]?.(head) ?? null;
  } catch {
    return null;
  }
}
