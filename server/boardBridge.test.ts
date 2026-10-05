import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { getRequestListener } from '@hono/node-server';
import { expect, it } from 'vitest';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { issueBoardGrant } from './boardMcp.js';
import { insertCard, insertProject } from './store.js';

it('connects a real stdio client to the local card tools through server discovery', async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'pm-board-bridge-'));
  const db = openDb(':memory:');
  const project = insertProject(db, 'Bridge', process.cwd());
  const card = insertCard(db, project, { title: 'Bridge task', description: '', status: 'todo' });
  const app = createApp(db, { dataDir: folder });
  await app.supervisor.ready;
  db.prepare(
    `INSERT INTO agent_sessions (project_id, card_id, name, provider_id, command_json, cwd, status, desired_state, supervise, created_at, started_at, log_path)
    VALUES (?, ?, 'Bridge', 'custom', '{}', ?, 'killed', 'stopped', 0, '2026-10-06', '2026-10-06', 'bridge-log')`,
  ).run(project, card.id, process.cwd());
  const token = issueBoardGrant(db, { kind: 'session', id: 1, logPath: 'bridge-log' });
  const server = createServer(getRequestListener(app.fetch));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  writeFileSync(
    path.join(folder, 'server.json'),
    JSON.stringify({ url: `http://127.0.0.1:${address.port}` }),
  );
  const child = spawn(process.execPath, [path.resolve('scripts/board-mcp.mjs'), folder], {
    env: { ...process.env, PM_BOARD_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    const response = new Promise<string>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
        if (output.includes('\n')) resolve(output.split('\n')[0]!);
      });
      child.on('error', reject);
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_card', arguments: {} },
      }) + '\n',
    );
    const rpc = JSON.parse(await response);
    expect(JSON.parse(rpc.result.content[0].text).title).toBe('Bridge task');
  } finally {
    child.stdin.end();
    await once(child, 'exit');
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.supervisor.shutdown();
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
}, 15_000);
