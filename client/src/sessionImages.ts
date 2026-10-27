import { api } from './api';

// Sending an image into a CLI session (PM-54). Phones have no Alt+V (the CLIs read the
// computer's clipboard there), so the image travels as a file: picked, pasted or dropped in the
// browser, uploaded to ProjectManager's data folder, and its path pasted into the session, which
// Claude Code and Codex attach as an image.

const SENDABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Larger photos are re-encoded: smaller uploads over Wi-Fi, and CLIs downscale anyway. */
const KEEP_BYTES = 2.5 * 1024 * 1024;
const MAX_EDGE = 2000;

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Could not read the image'));
    reader.readAsDataURL(blob);
  });
}

/** The image as the upload API takes it: as is when small and a common type, else a JPEG. */
export async function prepareImage(
  file: File,
): Promise<{ name: string; type: string; data: string }> {
  // iOS sometimes hands over a photo with no type: go by its name then (PM-130), so a normal
  // JPEG or PNG is sent as is rather than re-encoded.
  const byName: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  const type = file.type || byName[/\.([a-z]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? ''] || '';
  if (SENDABLE.has(type) && file.size <= KEEP_BYTES) {
    return { name: file.name || 'image', type, data: await base64(file) };
  }
  // Phone photos (often several MB, sometimes HEIC): scale the long edge to 2000px as JPEG.
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('This image format can’t be read here; try a PNG or JPEG');
  });
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))),
      'image/jpeg',
      0.85,
    ),
  );
  const name = (file.name || 'photo').replace(/\.[^.]*$/, '') + '.jpg';
  return { name, type: 'image/jpeg', data: await base64(blob) };
}

/**
 * The image on this device's clipboard, read by the browser (Alt+V away from the computer).
 * 'none' when the clipboard holds no image, 'unavailable' when the browser cannot read it here
 * (plain-http LAN pages are not a secure context, or the permission was refused).
 */
export async function clipboardImage(): Promise<File | 'none' | 'unavailable'> {
  if (!navigator.clipboard?.read) return 'unavailable';
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      return new File([blob], `image.${type.slice(6).replace('jpeg', 'jpg')}`, { type });
    }
    return 'none';
  } catch {
    return 'unavailable';
  }
}

/**
 * Where a pane's pastes go. The chat view also takes picked images itself (`addImages`), so the
 * pane's image button shows them in the composer at once instead of uploading first (PM-301).
 */
export type PasteTarget = ((text: string) => void) & { addImages?: (files: File[]) => void };

/**
 * Uploads an image for a session and pastes its path into the terminal (as a paste, so a CLI
 * that asked for bracketed paste sees one, which is how they recognise an image path).
 */
export async function sendImageToSession(
  sessionId: number,
  file: File,
  paste: ((text: string) => void) | null,
): Promise<void> {
  const { path } = await api.uploadSessionImage(sessionId, await prepareImage(file));
  if (paste) paste(path);
  else await api.sendSessionInput(sessionId, path);
}
