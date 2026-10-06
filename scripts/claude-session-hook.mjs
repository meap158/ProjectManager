// Claude Code hook, injected per process by ProjectManager (server/boardMcp.ts) for SessionStart,
// UserPromptSubmit, Stop and Notification. It reports the event and the live conversation id to
// the local ProjectManager server: the id becomes the session's resume target (Claude switches
// conversations on /resume, /clear and compaction), and the event tells working from idle exactly
// (a turn started / ended / Claude is waiting for you).
// Never blocks Claude: any failure exits 0 silently.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const dataDir = process.argv[2];
const token = process.env.PM_BOARD_TOKEN;

try {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const {
    session_id: sessionId,
    source,
    hook_event_name: event,
    notification_type: notificationType,
  } = JSON.parse(input || '{}');
  if (dataDir && token && typeof sessionId === 'string') {
    const { url } = JSON.parse(await readFile(path.join(dataDir, 'server.json'), 'utf8'));
    const endpoint = new URL('/api/agent-hooks/claude-session', url);
    // "localhost" may resolve to ::1, where another app can hold the same port: use the IPv4
    // loopback ProjectManager always binds.
    if (endpoint.hostname === 'localhost') endpoint.hostname = '127.0.0.1';
    if (
      endpoint.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    ) {
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId,
          source: typeof source === 'string' ? source : null,
          event: typeof event === 'string' ? event : null,
          notificationType: typeof notificationType === 'string' ? notificationType : null,
        }),
        signal: AbortSignal.timeout(5_000),
        redirect: 'error',
      });
    }
  }
} catch {
  // Reporting is best effort; Claude must start regardless.
}
process.exit(0);
