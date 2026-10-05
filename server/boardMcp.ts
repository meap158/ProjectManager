import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { z } from 'zod';
import { CARD_STATUSES } from '../shared/types.js';
import type { Db } from './db.js';
import { getCard, getSetting, setSetting, updateCard } from './store.js';
import { cardAttachmentsDir, listAttachments } from './attachments.js';

type Owner = { kind: 'session' | 'run'; id: number; logPath: string };
const tokenKey = (token: string) => `board-mcp:${createHash('sha256').update(token).digest('hex')}`;
const object = { type: 'object', properties: {}, additionalProperties: false };
export const BOARD_TOOLS = [
  {
    name: 'get_card',
    description: 'Read your currently assigned card and its image attachments.',
    inputSchema: object,
  },
  {
    name: 'update_status',
    description: 'Move your card. Validate the work before moving to review or done.',
    inputSchema: {
      ...object,
      properties: { status: { type: 'string', enum: CARD_STATUSES } },
      required: ['status'],
    },
  },
  {
    name: 'add_note',
    description: 'Append progress, validation evidence or a blocker to your card.',
    inputSchema: {
      ...object,
      properties: { note: { type: 'string', minLength: 1, maxLength: 4000 } },
      required: ['note'],
    },
  },
  {
    name: 'read_image',
    description:
      'Read an attached image as native MCP image content. Index is zero-based, from get_card.',
    inputSchema: {
      ...object,
      properties: { index: { type: 'integer', minimum: 0 } },
      required: ['index'],
    },
  },
];

/** Grants are indexed by a token hash. The grant follows the owner's current card, never an arbitrary id. */
export function issueBoardGrant(db: Db, owner: Owner): string {
  const token = randomBytes(32).toString('hex');
  setSetting(db, tokenKey(token), owner);
  return token;
}

/** Inject per-process stdio configuration, without changing a project's/global CLI config. */
export function boardConnection(
  db: Db,
  dataDir: string,
  owner: Owner,
  providerId: string,
  command: string[],
  env: Record<string, string>,
): { command: string[]; env: Record<string, string> } {
  if (
    !['claude', 'codex', 'opencode', 'antigravity', 'gemini'].includes(providerId) ||
    (command[0] !== providerId && (providerId !== 'antigravity' || command[0] !== 'agy'))
  )
    return { command, env };
  // Reuse the secret on relaunch so hosted sessions stay connected after server restarts.
  const secretKey = `board-mcp-owner:${owner.kind}:${owner.id}:${owner.logPath}`;
  let token = getSetting<string>(db, secretKey);
  if (!token) {
    token = issueBoardGrant(db, owner);
    setSetting(db, secretKey, token);
  }
  const bridge = fileURLToPath(new URL('../scripts/board-mcp.mjs', import.meta.url));
  // Compiled server lives in dist/server; the bridge remains in the repo's scripts folder.
  const script = bridge.includes(`${path.sep}dist${path.sep}`)
    ? path.resolve(path.dirname(bridge), '../../scripts/board-mcp.mjs')
    : bridge;
  const args = [script, dataDir];
  const nextEnv = { ...env, PM_BOARD_TOKEN: token };
  if (providerId === 'gemini') {
    const original =
      env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ||
      process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ||
      (process.platform === 'win32'
        ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'gemini-cli/system-defaults.json')
        : process.platform === 'darwin'
          ? '/Library/Application Support/GeminiCli/system-defaults.json'
          : '/etc/gemini-cli/system-defaults.json');
    const defaults = existsSync(original)
      ? (JSON.parse(readFileSync(original, 'utf8')) as Record<string, unknown>)
      : {};
    const folder = path.join(dataDir, 'agent-config');
    mkdirSync(folder, { recursive: true });
    const file = path.join(
      folder,
      `gemini-${createHash('sha256').update(owner.logPath).digest('hex').slice(0, 20)}.json`,
    );
    writeFileSync(
      file,
      JSON.stringify({
        ...defaults,
        mcpServers: {
          ...((defaults.mcpServers as object) ?? {}),
          projectmanager: {
            command: process.execPath,
            args,
            env: { PM_BOARD_TOKEN: '${PM_BOARD_TOKEN}' },
          },
        },
      }),
    );
    return { command, env: { ...nextEnv, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: file } };
  }
  if (providerId === 'claude') {
    const config = {
      mcpServers: {
        projectmanager: {
          command: process.execPath,
          args,
          env: { PM_BOARD_TOKEN: '${PM_BOARD_TOKEN}' },
        },
      },
    };
    return {
      command: [command[0]!, '--mcp-config', JSON.stringify(config), ...command.slice(1)],
      env: nextEnv,
    };
  }
  if (providerId === 'codex') {
    return {
      command: [
        command[0]!,
        '-c',
        `mcp_servers.projectmanager.command=${JSON.stringify(process.execPath)}`,
        '-c',
        `mcp_servers.projectmanager.args=${JSON.stringify(args)}`,
        '-c',
        'mcp_servers.projectmanager.env_vars=["PM_BOARD_TOKEN"]',
        ...command.slice(1),
      ],
      env: nextEnv,
    };
  }
  const existing = JSON.parse(
    env.OPENCODE_CONFIG_CONTENT || process.env.OPENCODE_CONFIG_CONTENT || '{}',
  ) as Record<string, unknown>;
  return {
    command,
    env: {
      ...nextEnv,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        ...existing,
        mcp: {
          ...((existing.mcp as object) ?? {}),
          projectmanager: {
            type: 'local',
            command: [process.execPath, ...args],
            environment: { PM_BOARD_TOKEN: token },
            enabled: true,
          },
        },
      }),
    },
  };
}

export const boardTaskNote =
  '\n\nProjectManager board tools: call projectmanager get_card to read your current task and image list, read_image for each attachment, add_note for progress/validation evidence, and update_status to review after validating. Use done only when all requirements are fulfilled.';

export function registerBoardMcp(app: Hono, db: Db, attachmentsRoot: string): void {
  app.post('/board-mcp', async (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    const owner = token ? getSetting<Owner>(db, tokenKey(token)) : null;
    if (!owner) return c.json({ error: 'Invalid board capability' }, 403);
    const table = owner.kind === 'session' ? 'agent_sessions' : 'agent_runs';
    const row = db
      .prepare(`SELECT card_id, project_id, log_path FROM ${table} WHERE id = ?`)
      .get(owner.id) as
      { card_id: number | null; project_id: number; log_path: string } | undefined;
    if (!row || row.log_path !== owner.logPath)
      return c.json({ error: 'Board capability revoked' }, 403);
    const rpc = z
      .object({
        jsonrpc: z.literal('2.0'),
        id: z.union([z.string(), z.number(), z.null()]).optional(),
        method: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!rpc.success)
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } },
        400,
      );
    const { id, method, params } = rpc.data;
    if (id === undefined) return c.body(null, 202);
    const reply = (result: unknown) => c.json({ jsonrpc: '2.0', id, result });
    if (method === 'initialize')
      return reply({
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'projectmanager', version: '1.0.0' },
      });
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: BOARD_TOOLS });
    if (method !== 'tools/call')
      return c.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    try {
      const call = z
        .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) })
        .parse(params);
      const card = row.card_id ? getCard(db, row.card_id) : null;
      if (!card || card.projectId !== row.project_id)
        throw new Error('No card assigned. Attach a card to this session first.');
      let value: unknown;
      if (call.name === 'get_card') {
        z.object({}).strict().parse(call.arguments);
        value = {
          ...card,
          attachments: listAttachments(attachmentsRoot, card.id).map((a, index) => ({
            index,
            name: a.name,
            type: a.type,
            bytes: a.bytes,
          })),
        };
      } else if (call.name === 'read_image') {
        const { index } = z
          .object({ index: z.number().int().min(0) })
          .strict()
          .parse(call.arguments);
        const image = listAttachments(attachmentsRoot, card.id)[index];
        if (!image) throw new Error('Image index not found');
        return reply({
          content: [
            {
              type: 'image',
              mimeType: image.type,
              data: readFileSync(
                path.join(cardAttachmentsDir(attachmentsRoot, card.id), image.file),
              ).toString('base64'),
            },
          ],
        });
      } else if (call.name === 'update_status' || call.name === 'add_note') {
        const patch =
          call.name === 'update_status'
            ? z
                .object({ status: z.enum(CARD_STATUSES) })
                .strict()
                .parse(call.arguments)
            : {
                description: `${card.description}\n\nAgent note (${new Date().toISOString()}):\n${
                  z
                    .object({ note: z.string().trim().min(1).max(4000) })
                    .strict()
                    .parse(call.arguments).note
                }`,
              };
        if ('description' in patch && patch.description.length > 20_000)
          throw new Error('Card notes are full (20,000 characters)');
        db.exec('BEGIN');
        try {
          value = updateCard(db, card.id, patch);
          db.prepare(
            'INSERT INTO board_agent_audit (card_id, owner_kind, owner_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(
            card.id,
            owner.kind,
            owner.id,
            call.name,
            JSON.stringify(call.arguments),
            new Date().toISOString(),
          );
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      } else throw new Error('Unknown tool');
      return reply({ content: [{ type: 'text', text: JSON.stringify(value) }] });
    } catch (e) {
      return reply({ isError: true, content: [{ type: 'text', text: (e as Error).message }] });
    }
  });
  app.get('/board-mcp', (c) => c.body(null, 405));
  app.get('/cards/:id/agent-audit', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || !getCard(db, id)) return c.json({ error: 'Card not found' }, 404);
    return c.json(
      db
        .prepare(
          'SELECT owner_kind, owner_id, action, detail, created_at FROM board_agent_audit WHERE card_id = ? ORDER BY id DESC LIMIT 100',
        )
        .all(id),
    );
  });
}
