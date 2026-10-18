// Claude Code status line, injected per session by ProjectManager (server/boardMcp.ts). Claude
// passes its status JSON on stdin, which is the only documented place it reports plan usage
// (rate_limits.five_hour / seven_day: used_percentage, resets_at; Pro/Max, after the first reply;
// https://code.claude.com/docs/en/statusline). This records that block for Settings and the Agent
// work lists (PM-17), then hands off to the user's own status line, so what they see is unchanged:
//  - their statusLine command from the settings Claude would have used (project-local, project,
//    then user), run like Claude runs it (a shell command, in the session's folder, same stdin);
//  - its output is passed through as is; with none configured, nothing is printed (as before).
// Never breaks Claude: recording failures are ignored and every path exits 0.
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = process.argv[2];

let input = '';
for await (const chunk of process.stdin) input += chunk;

let status = {};
try {
  status = JSON.parse(input || '{}');
} catch {
  // Not JSON: still hand off to the user's status line below.
}

try {
  const limits = status.rate_limits;
  if (dataDir && limits && (limits.five_hour || limits.seven_day)) {
    const file = path.join(dataDir, 'claude-limits.json');
    const record = {
      asOf: new Date().toISOString(),
      fiveHour: limits.five_hour ?? null,
      sevenDay: limits.seven_day ?? null,
    };
    // Write then rename: a reader never sees half a file, and parallel sessions just take turns.
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(record));
    renameSync(temp, file);
    // Attribute usage to the login that emitted this status, never every saved profile.
    const identity = process.argv[3];
    if (typeof identity === 'string' && /^[a-f0-9]{64}$/.test(identity)) {
      const folder = path.join(dataDir, 'claude-account-usage', identity);
      mkdirSync(folder, { recursive: true });
      const accountFile = path.join(folder, 'claude-limits.json');
      const accountTemp = `${accountFile}.${process.pid}.tmp`;
      writeFileSync(accountTemp, JSON.stringify(record));
      renameSync(accountTemp, accountFile);
    }
  }
} catch {
  // Recording is best effort.
}

/** The statusLine Claude would have used without ProjectManager's, by settings precedence. */
function userStatusLine(cwd) {
  const files = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  for (const file of files) {
    try {
      const line = JSON.parse(readFileSync(file, 'utf8')).statusLine;
      if (line && line.type === 'command' && typeof line.command === 'string') return line.command;
    } catch {
      // Missing or unreadable: try the next level.
    }
  }
  return null;
}

const cwd = status.workspace?.current_dir || status.cwd || process.cwd();
const command = userStatusLine(cwd);
if (!command) process.exit(0);

// The user's own command, configured by them for Claude, run through the shell Claude uses for
// such commands: PowerShell on Windows (as with hooks, see server/boardMcp.ts), sh elsewhere.
const shell = process.platform === 'win32' ? 'powershell.exe' : true;
const child = spawn(command, { shell, cwd, stdio: ['pipe', 'inherit', 'inherit'] });
child.on('error', () => process.exit(0));
child.on('exit', () => process.exit(0));
child.stdin.on('error', () => undefined);
child.stdin.end(input);
