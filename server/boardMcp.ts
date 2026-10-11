import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { z } from 'zod';
import { CARD_STATUSES } from '../shared/types.js';
import type { Db } from './db.js';
import { getCard, getSetting, insertCard, setSetting, updateCard } from './store.js';
import { cardAttachmentsDir, listAttachments } from './attachments.js';
import { recordEvent } from './agents/turnState.js';

type Owner = { kind: 'session' | 'run'; id: number; logPath: string };
const tokenKey = (token: string) => `board-mcp:${createHash('sha256').update(token).digest('hex')}`;
const object = { type: 'object', properties: {}, additionalProperties: false };
export const BOARD_TOOLS = [
  {
    name: 'get_card',
    description:
      'Read your currently assigned card and its image attachments. Reference its key in commit messages ("Refs PM-12" while working, "Fixes PM-12" when complete) so the board follows.',
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
    name: 'create_card',
    description:
      'Only when you have no card yet (work started directly in a terminal): create a card for it in this project. It becomes your card, so update_status and add_note apply to it.',
    inputSchema: {
      ...object,
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        notes: { type: 'string', maxLength: 4000 },
        status: { type: 'string', enum: CARD_STATUSES },
      },
      required: ['title'],
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

/** A file in the repo's scripts folder (the compiled server lives in dist/server). */
function siblingScript(name: string): string {
  const file = fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
  return file.includes(`${path.sep}dist${path.sep}`)
    ? path.resolve(path.dirname(file), `../../scripts/${name}`)
    : file;
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
    !['claude', 'codex', 'opencode', 'antigravity'].includes(providerId) ||
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
  const args = [siblingScript('board-mcp.mjs'), dataDir];
  const nextEnv = { ...env, PM_BOARD_TOKEN: token };
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
    // Sessions also get a SessionStart hook that reports the live conversation id (Claude
    // switches on /resume, /clear and compaction), so relaunches resume the right conversation,
    // and a status line that records plan usage (Claude reports it nowhere else) before running
    // the user's own status line unchanged (scripts/claude-statusline.mjs, PM-17).
    const hook =
      owner.kind === 'session'
        ? [
            '--settings',
            JSON.stringify({
              statusLine: {
                type: 'command',
                command: `node "${siblingScript('claude-statusline.mjs')}" "${dataDir}"`,
              },
              hooks: Object.fromEntries(
                [
                  'SessionStart',
                  'UserPromptSubmit',
                  'Stop',
                  'Notification',
                  'SubagentStart',
                  'SubagentStop',
                ].map((event) => [
                  event,
                  [
                    {
                      hooks: [
                        {
                          type: 'command',
                          // A bare `node` first: Claude runs hooks through PowerShell on Windows
                          // (where a quoted program path is only a string) and sh elsewhere; this
                          // form works in both, and in cmd. Paths with spaces stay quoted arguments.
                          command: `node "${siblingScript('claude-session-hook.mjs')}" "${dataDir}"`,
                          timeout: 10,
                        },
                      ],
                    },
                  ],
                ]),
              ),
            }),
          ]
        : [];
    return {
      command: [command[0]!, '--mcp-config', JSON.stringify(config), ...hook, ...command.slice(1)],
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
  '\n\nProjectManager board tools: call projectmanager get_card to read your current task and image list, read_image for each attachment, add_note for progress/validation evidence, and update_status to review after validating. Use done only when all requirements are fulfilled.' +
  ' Commit atomically, one coherent change per commit with a descriptive message, and reference your card key in it ("Refs PM-12" while working, "Fixes PM-12" when complete): the board follows your commits automatically.';

/**
 * An orchestrator's chat CLI gets the master's tools instead of the single-card ones (PM-89):
 * same transport and capability token, scoped to the master's projects by the host.
 */
export interface OrchestratorToolHost {
  tools: unknown[];
  call(
    orchestratorId: string,
    sessionId: number,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

export function registerBoardMcp(
  app: Hono,
  db: Db,
  attachmentsRoot: string,
  orchestratorTools?: OrchestratorToolHost,
): void {
  app.post('/board-mcp', async (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    const owner = token ? getSetting<Owner>(db, tokenKey(token)) : null;
    if (!owner) return c.json({ error: 'Invalid board capability' }, 403);
    const table = owner.kind === 'session' ? 'agent_sessions' : 'agent_runs';
    const row = db
      .prepare(
        `SELECT card_id, project_id, log_path${owner.kind === 'session' ? ', orchestrator_id' : ''} FROM ${table} WHERE id = ?`,
      )
      .get(owner.id) as
      | {
          card_id: number | null;
          project_id: number;
          log_path: string;
          orchestrator_id?: string | null;
        }
      | undefined;
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
    const orchestratorId = row.orchestrator_id && orchestratorTools ? row.orchestrator_id : null;
    if (method === 'tools/list')
      return reply({ tools: orchestratorId ? orchestratorTools!.tools : BOARD_TOOLS });
    if (method !== 'tools/call')
      return c.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    try {
      const call = z
        .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) })
        .parse(params);
      if (orchestratorId) {
        const value = await orchestratorTools!.call(
          orchestratorId,
          owner.id,
          call.name,
          call.arguments,
        );
        return reply({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] });
      }
      const assigned = row.card_id ? getCard(db, row.card_id) : null;
      if (call.name === 'create_card') {
        if (assigned) throw new Error(`You already have a card (${assigned.key}); use it.`);
        const input = z
          .object({
            title: z.string().trim().min(1).max(200),
            notes: z.string().max(4000).default(''),
            status: z.enum(CARD_STATUSES).default('in_progress'),
          })
          .strict()
          .parse(call.arguments);
        // One transaction: the card, its assignment to this session/run, and the audit record.
        db.exec('BEGIN');
        try {
          const created = insertCard(db, row.project_id, {
            title: input.title,
            description: input.notes,
            status: input.status,
          });
          db.prepare(`UPDATE ${table} SET card_id = ? WHERE id = ?`).run(created.id, owner.id);
          db.prepare(
            'INSERT INTO board_agent_audit (card_id, owner_kind, owner_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(
            created.id,
            owner.kind,
            owner.id,
            'create_card',
            JSON.stringify(input),
            new Date().toISOString(),
          );
          db.exec('COMMIT');
          return reply({ content: [{ type: 'text', text: JSON.stringify(created) }] });
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }
      const card = assigned;
      if (!card || card.projectId !== row.project_id)
        throw new Error(
          'No card assigned. If this work has no card yet, call create_card to make one.',
        );
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

  // Claude SessionStart hook (scripts/claude-session-hook.mjs): the conversation a session is
  // in right now. Stored as its resume target, so restarts reopen that conversation, not the
  // one it was launched with (Claude switches on /resume, /clear and compaction).
  app.post('/agent-hooks/claude-session', async (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
    const owner = token ? getSetting<Owner>(db, tokenKey(token)) : null;
    if (!owner || owner.kind !== 'session') return c.json({ error: 'Invalid capability' }, 403);
    const row = db
      .prepare('SELECT provider_id, log_path, command_json FROM agent_sessions WHERE id = ?')
      .get(owner.id) as { provider_id: string; log_path: string; command_json: string } | undefined;
    if (!row || row.log_path !== owner.logPath || row.provider_id !== 'claude')
      return c.json({ error: 'Capability revoked' }, 403);
    const body = z
      .object({
        sessionId: z.string().uuid(),
        source: z.string().max(40).nullable().optional(),
        event: z.string().max(40).nullable().optional(),
        notificationType: z.string().max(60).nullable().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Expected { sessionId }' }, 400);
    const binary = (JSON.parse(row.command_json) as { command: string[] }).command[0] ?? 'claude';
    db.prepare('UPDATE agent_sessions SET resume_json = ? WHERE id = ?').run(
      JSON.stringify([binary, '--resume', body.data.sessionId]),
      owner.id,
    );
    // Working vs idle, exactly as Claude reports it (no event name: an older hook = SessionStart).
    recordEvent(owner.id, body.data.event ?? 'SessionStart', body.data.notificationType);
    return c.body(null, 204);
  });
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
