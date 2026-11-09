import { MEDIA_TYPES } from '../../../shared/media';

/*
 * Media previews that download managers leave alone (PM-597).
 *
 * Internet Download Manager and similar tools hook the request, not the element that made it:
 * any response typed video/* or audio/* is taken over (and the browser's own copy cancelled),
 * whatever the page meant by it. So the Files tab asks the server for the bytes under a type
 * nothing recognises, with the path encoded so the URL has no ".mp4" either, and gives the
 * bytes their real type here, in a blob the player can use. The same approach as TrendRelay's
 * `apps/web/lib/media-preview.ts`.
 *
 * The cost is that the whole file is read before the first frame. On this computer that is a
 * disk read; over the LAN or the tunnel it is a transfer, so large files wait for the owner to
 * ask, with progress and a way to cancel.
 */

/** Files up to this size load on their own; larger ones wait for "Load preview". */
export const AUTO_LOAD_BYTES = 64 * 1024 * 1024;

const base64url = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** The preview's own URL: opaque type, path encoded, no file extension anywhere in it. */
export function opaqueMediaUrl(projectId: number, path: string): string {
  return `/api/projects/${projectId}/media?opaque=1&p=${base64url(path)}`;
}

/** The real type for a media path, from its extension. */
export function mediaTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  return (dot >= 0 && MEDIA_TYPES[path.slice(dot).toLowerCase()]) || 'application/octet-stream';
}

/**
 * Reads the media opaquely and returns a blob with its real type. Reports progress as bytes
 * arrive; aborts with the signal.
 */
export async function loadOpaqueMedia(
  projectId: number,
  path: string,
  { signal, onProgress }: { signal?: AbortSignal; onProgress?: (loaded: number) => void } = {},
): Promise<Blob> {
  const response = await fetch(opaqueMediaUrl(projectId, path), { signal });
  if (!response.ok) {
    let message = `The file could not be read (${response.status}).`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* Not JSON: keep the status message. */
    }
    throw new Error(message);
  }
  const type = mediaTypeFor(path);
  const reader = response.body?.getReader();
  // Not response.blob() alone: it would carry the opaque type to the player, which refuses it.
  if (!reader) return new Blob([await response.blob()], { type });
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded);
  }
  return new Blob(parts as BlobPart[], { type });
}
