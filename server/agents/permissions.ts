import type { AgentAutonomy, AgentPermissions, PermissionLevel } from '../../shared/types.js';
import type { Db } from '../db.js';
import { getSetting, setSetting } from '../store.js';

// Global agent permissions with per-CLI overrides, applied to interactive sessions at every
// (re)launch and used as the default level for one-shot runs. Each level maps onto the CLI's own
// documented permission model (from each CLI's --help):
//
//   CLI          read-only                        edit files                        full access
//   claude       --permission-mode plan           --permission-mode acceptEdits     --permission-mode bypassPermissions
//   codex        --sandbox read-only              --sandbox workspace-write         --sandbox danger-full-access
//   grok         --permission-mode plan           --permission-mode acceptEdits     --permission-mode bypassPermissions
//   antigravity  --mode plan                      --mode accept-edits               --dangerously-skip-permissions
//   opencode     config: edit deny, bash ask      config: edit allow, bash ask      config: edit/bash allow
//
// 'cli' passes nothing: the CLI's own config and defaults apply (the default, so nothing changes
// until the user picks a level).

const KEY = 'agent_permissions';

export const DEFAULT_PERMISSIONS: AgentPermissions = { global: 'cli', providers: {} };

/** Interactive-session flags per CLI and level. */
const SESSION_ARGS: Record<string, Partial<Record<AgentAutonomy, string[]>>> = {
  claude: {
    read: ['--permission-mode', 'plan'],
    edit: ['--permission-mode', 'acceptEdits'],
    full: ['--permission-mode', 'bypassPermissions'],
  },
  codex: {
    read: ['--sandbox', 'read-only'],
    edit: ['--sandbox', 'workspace-write'],
    full: ['--sandbox', 'danger-full-access'],
  },
  grok: {
    read: ['--permission-mode', 'plan'],
    edit: ['--permission-mode', 'acceptEdits'],
    full: ['--permission-mode', 'bypassPermissions'],
  },
  antigravity: {
    read: ['--mode', 'plan'],
    edit: ['--mode', 'accept-edits'],
    full: ['--dangerously-skip-permissions'],
  },
};

/** OpenCode has no permission flags: its `permission` config block, merged into the config. */
const OPENCODE_PERMISSION: Record<AgentAutonomy, Record<string, string>> = {
  read: { edit: 'deny', bash: 'ask', webfetch: 'allow' },
  edit: { edit: 'allow', bash: 'ask', webfetch: 'allow' },
  full: { edit: 'allow', bash: 'allow', webfetch: 'allow' },
};

/** CLIs ProjectManager can set a permission level for. */
export const PERMISSION_PROVIDERS = [...Object.keys(SESSION_ARGS), 'opencode'];

export function getPermissions(db: Db): AgentPermissions {
  return { ...DEFAULT_PERMISSIONS, ...(getSetting<AgentPermissions>(db, KEY) ?? {}) };
}

export function setPermissions(db: Db, value: AgentPermissions): AgentPermissions {
  setSetting(db, KEY, value);
  return value;
}

/** The level that applies to one CLI: its own override, else the global level. */
export function effectiveLevel(perms: AgentPermissions, providerId: string): PermissionLevel {
  const own = perms.providers[providerId];
  return own && own !== 'inherit' ? own : perms.global;
}

/**
 * The session command and environment with the CLI's permission level applied. The binary must be
 * command[0]; flags go right after it (before any subcommand such as `codex resume <id>`), and
 * user-written flags for the same setting are left alone (the level is only added when absent).
 */
/**
 * The permission mode a Claude Code screen shows in its footer ("⏵⏵ auto mode on (shift+tab to
 * cycle)"), as a `--permission-mode` value, or null when none is shown (the default mode, or no
 * footer on screen).
 */
export function claudeModeOnScreen(screen: string): string | null {
  const footer = screen
    .split('\n')
    .reverse()
    .find((line) => line.includes('(shift+tab to cycle)'));
  if (!footer) return null;
  if (/\bauto mode on\b/.test(footer)) return 'auto';
  if (/\baccept edits on\b/.test(footer)) return 'acceptEdits';
  if (/\bplan mode on\b/.test(footer)) return 'plan';
  if (/\bbypass permissions on\b/.test(footer)) return 'bypassPermissions';
  if (/\bdon['’]t ask on\b/.test(footer)) return 'dontAsk';
  return null;
}

/**
 * The launch command with the Settings permission level applied. `carried` is the mode a Claude
 * Code session was in before a relaunch (cycled with Shift+Tab): it is kept instead of the
 * Settings default, or every restart reset "auto mode" to "accept edits". It never raises a
 * session to bypassing permissions unless Settings allows full access.
 */
export function withPermissions(
  providerId: string,
  level: PermissionLevel,
  command: string[],
  env: Record<string, string>,
  carried?: string | null,
): { command: string[]; env: Record<string, string> } {
  if (
    providerId === 'claude' &&
    carried &&
    command.length > 0 &&
    !command.includes('--permission-mode') &&
    (carried !== 'bypassPermissions' || level === 'full')
  ) {
    return { command: [command[0]!, '--permission-mode', carried, ...command.slice(1)], env };
  }
  if (level === 'cli' || command.length === 0) return { command, env };
  if (providerId === 'opencode') {
    const existing = JSON.parse(
      env.OPENCODE_CONFIG_CONTENT || process.env.OPENCODE_CONFIG_CONTENT || '{}',
    ) as Record<string, unknown>;
    if (existing.permission) return { command, env }; // An explicit config wins.
    return {
      command,
      env: {
        ...env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          ...existing,
          permission: OPENCODE_PERMISSION[level],
        }),
      },
    };
  }
  const args = SESSION_ARGS[providerId]?.[level];
  if (!args) return { command, env };
  if (command.includes(args[0]!)) return { command, env };
  return { command: [command[0]!, ...args, ...command.slice(1)], env };
}
