// Provider catalog for AI coding CLIs plus the built-in shell/custom entries.
//
// Modelled on Quil's typed panes (github.com/artyomsv/quil): each pane type knows
// its binary (PATH-probed, greyed with an install link when missing), its
// non-interactive invocation, and its own resume strategy for reboots.
// Only stdlib is used (no new dependencies): availability is probed with
// the same resolver the supervisor spawns with (Windows) or `command -v` (POSIX).

import { execFile } from 'node:child_process';
import type { AgentAutonomy, AgentProvider, AgentProviderStatus } from '../../shared/types.js';
import { recipeFor } from './install.js';
import { ResolveError, resolveArgv } from './resolve.js';

export const PROMPT_PLACEHOLDER = '{prompt}';
export const SESSION_ID_PLACEHOLDER = '{sessionId}';

// Autonomy flags were checked against each CLI's --help (Claude Code 2.1, codex-cli 0.160,
// Gemini CLI, OpenCode). Print/exec modes can't ask for approval, so without these flags runs
// silently decline every edit and still exit 0.
export const PROVIDERS: AgentProvider[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    binary: 'claude',
    argsTemplate: ['-p', PROMPT_PLACEHOLDER],
    // Each session pins its own conversation id, and relaunches resume exactly that one, so
    // several Claude panes in one project never collide after a reboot.
    sessionIdArgs: ['--session-id', SESSION_ID_PLACEHOLDER],
    resumeArgs: ['--resume', SESSION_ID_PLACEHOLDER],
    interactivePromptArgs: [PROMPT_PLACEHOLDER],
    autonomyArgs: {
      read: ['--permission-mode', 'plan'],
      edit: ['--permission-mode', 'acceptEdits'],
      full: ['--permission-mode', 'bypassPermissions'],
    },
    description: 'Anthropic Claude Code, non-interactive print mode',
    installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  {
    id: 'codex',
    name: 'Codex',
    binary: 'codex',
    argsTemplate: ['exec', PROMPT_PLACEHOLDER],
    interactivePromptArgs: [PROMPT_PLACEHOLDER],
    // Only "most recent session" resume exists: used when this is the folder's only Codex session.
    resumeLatestArgs: ['resume', '--last'],
    // exec never prompts; the sandbox policy decides what is allowed.
    autonomyArgs: {
      read: ['--sandbox', 'read-only'],
      edit: ['--sandbox', 'workspace-write'],
      full: ['--sandbox', 'danger-full-access'],
    },
    description: 'OpenAI Codex CLI, non-interactive exec mode',
    installUrl: 'https://github.com/openai/codex',
  },
  {
    id: 'grok',
    name: 'Grok',
    binary: 'grok',
    argsTemplate: ['-p', PROMPT_PLACEHOLDER],
    description: 'xAI Grok Build coding agent, non-interactive print mode',
    installUrl: 'https://docs.x.ai/build/overview',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    binary: 'opencode',
    argsTemplate: ['run', PROMPT_PLACEHOLDER],
    interactivePromptArgs: ['--prompt', PROMPT_PLACEHOLDER],
    resumeLatestArgs: ['--continue'],
    // No read-only switch; OpenCode's own permission config applies unless --auto.
    autonomyArgs: { edit: [], full: ['--auto'] },
    description: 'OpenCode agent runner, non-interactive run mode',
    installUrl: 'https://opencode.ai',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    binary: 'gemini',
    argsTemplate: ['-p', PROMPT_PLACEHOLDER],
    interactivePromptArgs: ['--prompt-interactive', PROMPT_PLACEHOLDER],
    resumeLatestArgs: ['--resume', 'latest'],
    autonomyArgs: {
      read: ['--approval-mode', 'plan'],
      edit: ['--approval-mode', 'auto_edit'],
      full: ['--approval-mode', 'yolo'],
    },
    description: 'Google Gemini CLI, non-interactive prompt mode',
    installUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'shell',
    name: 'Shell',
    binary: null,
    argsTemplate: [],
    description: 'Interactive OS shell for this machine',
  },
  {
    id: 'custom',
    name: 'Custom command',
    binary: null,
    argsTemplate: [],
    description: 'Any executable with explicit arguments (e.g. another AI CLI)',
  },
];

export function getProvider(id: string): AgentProvider | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * Finds what would actually be executed for a binary. On Windows this uses the same resolver the
 * supervisor spawns with, so "available" means "can really be launched" (a batch file that can't
 * be unwrapped is unavailable, with the reason).
 */
async function lookupBinary(binary: string): Promise<{ path: string | null; reason?: string }> {
  if (process.platform === 'win32') {
    try {
      const argv = await resolveArgv([binary]);
      return { path: argv[argv.length - 1]! };
    } catch (e) {
      return { path: null, reason: e instanceof ResolveError ? e.message : String(e) };
    }
  }
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', `command -v ${JSON.stringify(binary)}`],
      { timeout: 5000 },
      (error, stdout) => {
        const first = stdout
          ?.split(/\r?\n/)
          .map((l) => l.trim())
          .find(Boolean);
        resolve(
          error || !first ? { path: null, reason: `${binary} is not on PATH` } : { path: first },
        );
      },
    );
  });
}

function defaultShell(): string[] {
  // No login wrapper: the supervisor passes the command straight to the OS.
  return process.platform === 'win32' ? ['cmd.exe'] : [process.env.SHELL || '/bin/sh'];
}

/** argv for an interactive session: the CLI's REPL, pinned to our session id when supported,
    optionally starting on a first prompt (e.g. the Kanban card's task). */
export function buildInteractiveArgv(
  provider: AgentProvider,
  options: { sessionId?: string; prompt?: string } = {},
): string[] {
  if (provider.id === 'shell') return defaultShell();
  if (provider.id === 'custom' || !provider.binary) return [];
  const fill = (args: string[]) =>
    args.map((a) =>
      a === SESSION_ID_PLACEHOLDER
        ? options.sessionId!
        : a === PROMPT_PLACEHOLDER
          ? options.prompt!
          : a,
    );
  return [
    provider.binary,
    ...(options.sessionId && provider.sessionIdArgs ? fill(provider.sessionIdArgs) : []),
    ...(options.prompt && provider.interactivePromptArgs
      ? fill(provider.interactivePromptArgs)
      : []),
  ];
}

/** Whether the provider's interactive mode can start on a first prompt. */
export function supportsInteractivePrompt(provider: AgentProvider): boolean {
  return provider.interactivePromptArgs !== undefined;
}

/** Statuses for the whole catalog. Results are cached briefly to avoid probing on every poll. */
let cache: { at: number; statuses: AgentProviderStatus[] } | null = null;
const CACHE_MS = 30_000;

export async function providerStatuses(force = false): Promise<AgentProviderStatus[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.statuses;
  const statuses = await Promise.all(
    PROVIDERS.map(async (p): Promise<AgentProviderStatus> => {
      const install = recipeFor(p) ?? null;
      if (p.id === 'shell' || p.id === 'custom') {
        return {
          ...p,
          available: true,
          resolvedPath: p.id === 'shell' ? defaultShell()[0]! : null,
          install,
        };
      }
      const found = await lookupBinary(p.binary!);
      return {
        ...p,
        available: found.path !== null,
        resolvedPath: found.path,
        ...(found.reason ? { unavailableReason: found.reason } : {}),
        install,
      };
    }),
  );
  cache = { at: Date.now(), statuses };
  return statuses;
}

export async function providerAvailable(id: string): Promise<boolean> {
  const found = (await providerStatuses()).find((p) => p.id === id);
  return found?.available ?? false;
}

/** Whether a provider supports an autonomy level for one-shot runs. */
export function supportsAutonomy(provider: AgentProvider, autonomy: AgentAutonomy): boolean {
  return provider.autonomyArgs === undefined || provider.autonomyArgs[autonomy] !== undefined;
}

/** Build the full argv for a dispatch (binary first). The prompt is substituted for the
    placeholder, or appended when there is none; autonomy flags go before the prompt so
    subcommand CLIs (`codex exec <prompt>`) parse them. Never uses a shell: no shell injection. */
export function buildDispatchArgv(
  provider: AgentProvider,
  prompt: string,
  autonomy: AgentAutonomy = 'edit',
): string[] {
  if (provider.id === 'shell') return defaultShell();
  if (!provider.binary) return [];
  const extra = provider.autonomyArgs?.[autonomy] ?? [];
  const hasPlaceholder = provider.argsTemplate.includes(PROMPT_PLACEHOLDER);
  const template = hasPlaceholder
    ? provider.argsTemplate
    : [...provider.argsTemplate, PROMPT_PLACEHOLDER];
  const at = template.indexOf(PROMPT_PLACEHOLDER);
  // `-p <prompt>` style: keep the flag glued to its value and put extras before the pair.
  const splitAt = at > 0 && template[at - 1]!.startsWith('-') ? at - 1 : at;
  const filled = template.map((a) => (a === PROMPT_PLACEHOLDER ? prompt : a));
  return [provider.binary, ...filled.slice(0, splitAt), ...extra, ...filled.slice(splitAt)];
}

/** argv for relaunching a supervised session after a crash/reboot, or null when the provider
    has no safe resume path (it then starts fresh). Resume args that need a session id are only
    used when one was pinned at start. */
export function buildResumeArgv(provider: AgentProvider, sessionId?: string): string[] | null {
  if (!provider.binary || !provider.resumeArgs) return null;
  const needsId = provider.resumeArgs.includes(SESSION_ID_PLACEHOLDER);
  if (needsId && !sessionId) return null;
  return [
    provider.binary,
    ...provider.resumeArgs.map((a) => (a === SESSION_ID_PLACEHOLDER ? sessionId! : a)),
  ];
}
