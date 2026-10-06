import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { CardAttachment } from '../shared/types.js';
import type { Db } from './db.js';

// Images attached to a card as context for whoever (or whichever agent) works on it.
// Stored as plain files in the data folder, <dataDir>/attachments/<cardId>/<uuid>__<name>.<ext>,
// never inside the tracked project. Agents get their absolute paths in the task text.

export const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const TYPE_OF_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES_PER_CARD = 20;
// <uuid>__<safe name>.<ext>: the only file names this module creates or serves.
const FILE = /^[0-9a-f-]{36}__[\w .()-]{1,80}\.(png|jpg|gif|webp)$/;

export const cardAttachmentsDir = (root: string, cardId: number) => path.join(root, String(cardId));

function safeName(name: string): string {
  const base = path.basename(name).replace(/\.[^.]*$/, '');
  return (base.replace(/[^\w .()-]+/g, '_').trim() || 'image').slice(0, 80);
}

export function listAttachments(root: string, cardId: number): CardAttachment[] {
  const dir = cardAttachmentsDir(root, cardId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => FILE.test(f))
    .map((file) => {
      const stat = statSync(path.join(dir, file));
      const ext = file.slice(file.lastIndexOf('.') + 1);
      return {
        file,
        name: `${file.slice(38, file.lastIndexOf('.'))}.${ext}`,
        type: TYPE_OF_EXT[ext]!,
        bytes: stat.size,
        addedAt: stat.mtime.toISOString(),
        url: `/api/cards/${cardId}/attachments/${encodeURIComponent(file)}`,
      };
    })
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

export function removeAttachments(root: string, cardId: number): void {
  rmSync(cardAttachmentsDir(root, cardId), { recursive: true, force: true });
}

/** The lines added to an agent's task so it opens the card's images. Empty without images. */
export function attachmentNote(root: string, cardId: number): string {
  const images = listAttachments(root, cardId);
  if (images.length === 0) return '';
  const dir = cardAttachmentsDir(root, cardId);
  return [
    `Attached images (${images.length}), part of the task. Open each one before starting:`,
    ...images.map((a) => `- ${path.join(dir, a.file)}`),
  ].join('\n');
}

/** `prompt` with the card's image note appended (unchanged when the card has none). */
export function withAttachments(
  prompt: string,
  root: string,
  cardId: number,
  maxLength = 20_000,
): string {
  const note = attachmentNote(root, cardId);
  if (!note) return prompt;
  // Callers cap prompts at maxLength; trim the task text, never the image paths after it.
  return `${prompt.slice(0, Math.max(0, maxLength - note.length - 2))}\n\n${note}`;
}

const uploadBody = z.object({
  name: z.string().min(1).max(200),
  type: z.string(),
  /** Base64 file content (JSON-only API: writes must be application/json). */
  data: z.string().min(1),
});

class AttachmentError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}

export function registerAttachmentRoutes(app: Hono, db: Db, root: string): void {
  const cardExists = (id: number) => !!db.prepare('SELECT 1 FROM cards WHERE id = ?').get(id);
  const cardId = (raw: string) => {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) throw new AttachmentError(400, 'Invalid card id');
    if (!cardExists(id)) throw new AttachmentError(404, 'Card not found');
    return id;
  };
  const fail = (e: unknown) => {
    if (e instanceof AttachmentError) return { error: e.message, status: e.status };
    throw e;
  };

  app.get('/cards/:id/attachments', (c) => {
    try {
      return c.json(listAttachments(root, cardId(c.req.param('id'))));
    } catch (e) {
      const { error, status } = fail(e);
      return c.json({ error }, status);
    }
  });

  app.post('/cards/:id/attachments', async (c) => {
    try {
      const id = cardId(c.req.param('id'));
      const parsed = uploadBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new AttachmentError(400, 'Expected { name, type, data }');
      const ext = IMAGE_TYPES[parsed.data.type];
      if (!ext) throw new AttachmentError(415, 'Only PNG, JPEG, GIF and WebP images');
      const bytes = Buffer.from(parsed.data.data, 'base64');
      if (bytes.length === 0) throw new AttachmentError(400, 'Empty image');
      if (bytes.length > MAX_IMAGE_BYTES) throw new AttachmentError(413, 'Image over 8 MB');
      if (listAttachments(root, id).length >= MAX_IMAGES_PER_CARD) {
        throw new AttachmentError(409, `At most ${MAX_IMAGES_PER_CARD} images per card`);
      }
      const dir = cardAttachmentsDir(root, id);
      mkdirSync(dir, { recursive: true });
      const file = `${randomUUID()}__${safeName(parsed.data.name)}.${ext}`;
      writeFileSync(path.join(dir, file), bytes);
      return c.json(
        listAttachments(root, id).find((a) => a.file === file)!,
        201,
      );
    } catch (e) {
      const { error, status } = fail(e);
      return c.json({ error }, status);
    }
  });

  app.get('/cards/:id/attachments/:file', (c) => {
    try {
      const id = cardId(c.req.param('id'));
      const file = c.req.param('file');
      if (!FILE.test(file)) throw new AttachmentError(404, 'Not found');
      const full = path.join(cardAttachmentsDir(root, id), file);
      if (!existsSync(full)) throw new AttachmentError(404, 'Not found');
      const ext = file.slice(file.lastIndexOf('.') + 1);
      return c.body(readFileSync(full), 200, {
        'Content-Type': TYPE_OF_EXT[ext]!,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=31536000, immutable',
      });
    } catch (e) {
      const { error, status } = fail(e);
      return c.json({ error }, status);
    }
  });

  app.delete('/cards/:id/attachments/:file', (c) => {
    try {
      const id = cardId(c.req.param('id'));
      const file = c.req.param('file');
      if (!FILE.test(file)) throw new AttachmentError(404, 'Not found');
      rmSync(path.join(cardAttachmentsDir(root, id), file), { force: true });
      return c.body(null, 204);
    } catch (e) {
      const { error, status } = fail(e);
      return c.json({ error }, status);
    }
  });
}

// ---- Session images (PM-54) ---------------------------------------------------------------
// An image sent into a running CLI session: a phone has no Alt+V (that reads the computer's
// clipboard), so the browser uploads the file here and pastes its absolute path into the
// session, which the CLIs attach as an image. <dataDir>/attachments/sessions/<id>/, newest 50.

export const MAX_IMAGES_PER_SESSION = 50;
export const sessionImagesDir = (root: string, sessionId: number) =>
  path.join(root, 'sessions', String(sessionId));

export function removeSessionImages(root: string, sessionId: number): void {
  rmSync(sessionImagesDir(root, sessionId), { recursive: true, force: true });
}

export function registerSessionImageRoutes(app: Hono, db: Db, root: string): void {
  app.post('/agent-sessions/:id/images', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'Invalid session id' }, 400);
    if (!db.prepare('SELECT 1 FROM agent_sessions WHERE id = ?').get(id)) {
      return c.json({ error: 'Session not found' }, 404);
    }
    const parsed = uploadBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Expected { name, type, data }' }, 400);
    const ext = IMAGE_TYPES[parsed.data.type];
    if (!ext) return c.json({ error: 'Only PNG, JPEG, GIF and WebP images' }, 415);
    const bytes = Buffer.from(parsed.data.data, 'base64');
    if (bytes.length === 0) return c.json({ error: 'Empty image' }, 400);
    if (bytes.length > MAX_IMAGE_BYTES) return c.json({ error: 'Image over 8 MB' }, 413);
    const dir = sessionImagesDir(root, id);
    mkdirSync(dir, { recursive: true });
    const file = `${randomUUID()}__${safeName(parsed.data.name)}.${ext}`;
    writeFileSync(path.join(dir, file), bytes);
    // Keep the newest few: older ones were already read by the CLI when they were sent.
    const files = readdirSync(dir)
      .filter((f) => FILE.test(f))
      .map((f) => ({ f, t: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(MAX_IMAGES_PER_SESSION)) {
      rmSync(path.join(dir, old.f), { force: true });
    }
    return c.json({ path: path.join(dir, file) }, 201);
  });
}
