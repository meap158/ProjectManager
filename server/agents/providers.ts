// Provider catalog for AI coding CLIs plus the built-in shell/custom entries.
//
// Modelled on Quil's typed panes (github.com/artyomsv/quil): each pane type knows
// its binary (PATH-probed, greyed with an install link when missing), its
// non-interactive invocation, and its own resume strategy for reboots.
// Only stdlib is used (no new dependencies): availability is probed with
// `where` (Windows) or `command -v` (POSIX).

import { execFile } from 'node:child_process';
import type { AgentProvider, AgentProviderStatus } from '../../shared/types.js';

export const PROMPT_PLACEHOLDER = '{prompt}';

export const PROVIDERS: AgentProvider[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    binary: 'claude',
    argsTemplate: ['-p', PROMPT_PLACEHOLDER],
    // `claude --continue` resumes the most recent conversation in place —
    // the Quil-style resume path used when relaunching after a reboot.
    resumeArgs: ['--continue'],
    description: 'Anthropic Claude Code, non-interactive print mode',
    installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  {
    id: 'codex',
    name: 'Codex',
    binary: 'codex',
    argsTemplate: ['exec', PROMPT_PLACEHOLDER],
    description: 'OpenAI Codex CLI, non-interactive exec mode',
    installUrl: 'https://github.com/openai/codex',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    binary: 'opencode',
    argsTemplate: ['run', PROMPT_PLACEHOLDER],
    description: 'OpenCode agent runner, non-interactive run mode',
    installUrl: 'https://opencode.ai',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    binary: 'gemini',
    argsTemplate: ['-p', PROMPT_PLACEHOLDER],
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

function lookupBinary(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    const probe =
      process.platform === 'win32'
        ? { file: 'where', args: [binary] }
        : { file: '/bin/sh', args: ['-c', `command -v ${JSON.stringify(binary)}`] };
    execFile(probe.file, probe.args, { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(null);
      const first =
        stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find(Boolean) ?? null;
      resolve(first);
    });
  });
}

function defaultShell(): string[] {
  // No login wrapper: the supervisor passes the command straight to the OS.
  return process.platform === 'win32' ? ['cmd.exe'] : [process.env.SHELL || '/bin/sh'];
}

/** argv for an interactive session: the bare binary starts its REPL. */
export function buildInteractiveArgv(provider: AgentProvider): string[] {
  if (provider.id === 'shell') return defaultShell();
  if (provider.id === 'custom' || !provider.binary) return [];
  return [provider.binary];
}

/** Statuses for the whole catalog. Results are cached briefly to avoid probing on every poll. */
let cache: { at: number; statuses: AgentProviderStatus[] } | null = null;
const CACHE_MS = 30_000;

export async function providerStatuses(force = false): Promise<AgentProviderStatus[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.statuses;
  const statuses = await Promise.all(
    PROVIDERS.map(async (p) => {
      if (p.id === 'shell' || p.id === 'custom') {
        return {
          ...p,
          available: true,
          resolvedPath: p.id === 'shell' ? defaultShell()[0]! : null,
        };
      }
      const resolvedPath = await lookupBinary(p.binary!);
      return { ...p, available: resolvedPath !== null, resolvedPath };
    }),
  );
  cache = { at: Date.now(), statuses };
  return statuses;
}

export async function providerAvailable(id: string): Promise<boolean> {
  const found = (await providerStatuses()).find((p) => p.id === id);
  return found?.available ?? false;
}

/** Build the argv for a dispatch: substitute the prompt, or append it when the
    template carries no placeholder. Never uses a shell: no shell injection. */
export function buildDispatchArgv(provider: AgentProvider, prompt: string): string[] {
  if (provider.id === 'shell') return defaultShell();
  if (provider.argsTemplate.includes(PROMPT_PLACEHOLDER)) {
    return provider.argsTemplate.map((a) => (a === PROMPT_PLACEHOLDER ? prompt : a));
  }
  return [...provider.argsTemplate, prompt];
}

/** argv for relaunching a supervised session after a crash/reboot, or null when
    the provider has no known resume path (it simply starts fresh). */
export function buildResumeArgv(provider: AgentProvider): string[] | null {
  if (!provider.binary || !provider.resumeArgs) return null;
  return [provider.binary, ...provider.resumeArgs];
}
