// Claude Code SessionStart hook, injected per process by ProjectManager (server/boardMcp.ts).
// Claude switches conversations on /resume, /clear and compaction, so the id a session was
// launched with stops being the one to resume. This hook reports the live conversation id to the
// local ProjectManager server, which stores it as the session's resume target.
// Never blocks Claude: any failure exits 0 silently.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const dataDir = process.argv[2];
const token = process.env.PM_BOARD_TOKEN;

try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { session_id: sessionId, source } = JSON.parse(input || '{}');
  if (dataDir && token && typeof sessionId === 'string') {
    const { url } = JSON.parse(await readFile(path.join(dataDir, 'server.json'), 'utf8'));
    const endpoint = new URL('/api/agent-hooks/claude-session', url);
    if (
      endpoint.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    ) {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionId, source: typeof source === 'string' ? source : null }),
        signal: AbortSignal.timeout(5_000),
        redirect: 'error',
      });
    }
  }
} catch {
  // Reporting is best effort; Claude must start regardless.
}
process.exit(0);
