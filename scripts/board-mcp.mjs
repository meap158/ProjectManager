// MCP stdio transport. Resolve the live server on every request so port fallback/restarts work.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const dataDir = process.argv[2];
if (!dataDir || !process.env.PM_BOARD_TOKEN) process.exit(1);
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let rpc;
  try {
    rpc = JSON.parse(line);
    const { url } = JSON.parse(await readFile(path.join(dataDir, 'server.json'), 'utf8'));
    const endpoint = new URL('/api/board-mcp', url);
    // "localhost" may resolve to ::1, where another app can hold the same port: use the IPv4
    // loopback ProjectManager always binds.
    if (endpoint.hostname === 'localhost') endpoint.hostname = '127.0.0.1';
    if (
      endpoint.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    )
      throw new Error('Board server must be local');
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.PM_BOARD_TOKEN}`,
      },
      body: JSON.stringify(rpc),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`Board server returned ${res.status}`);
    if (rpc.id !== undefined) process.stdout.write(`${JSON.stringify(await res.json())}\n`);
  } catch (e) {
    if (rpc?.id !== undefined)
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: e.message } })}\n`,
      );
  }
}
