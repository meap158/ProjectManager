/**
 * The server caps a single session-input write at 64 KB (`inputBody` in
 * `server/agents/routes.ts`). One keystroke batch can hold a whole paste, so split it into
 * chunks that each fit comfortably — otherwise a big paste fails the entire paste.
 */
export const MAX_SESSION_INPUT_CHARS = 32 * 1024;

/**
 * Splits `data` into chunks of at most `MAX_SESSION_INPUT_CHARS` (sent in order, they
 * reassemble exactly). Never splits a UTF-16 surrogate pair across two writes.
 */
export function splitSessionInput(data: string): string[] {
  if (data.length === 0) return [];
  const parts: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + MAX_SESSION_INPUT_CHARS, data.length);
    if (end < data.length) {
      const tail = data.charCodeAt(end - 1);
      const head = data.charCodeAt(end);
      if (tail >= 0xd800 && tail <= 0xdbff && head >= 0xdc00 && head <= 0xdfff) end -= 1;
    }
    parts.push(data.slice(start, end));
    start = end;
  }
  return parts;
}
