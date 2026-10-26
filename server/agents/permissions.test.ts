import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { openDb } from '../db.js';
import { claudeModeOnScreen, effectiveLevel, withPermissions } from './permissions.js';
import { buildDispatchArgv, getProvider } from './providers.js';

describe('agent permissions', () => {
  it('maps each level onto the CLI’s own flags, after the binary', () => {
    expect(withPermissions('claude', 'read', ['claude', '--resume', 'x'], {}).command).toEqual([
      'claude',
      '--permission-mode',
      'plan',
      '--resume',
      'x',
    ]);
    // Before a subcommand, where Codex expects global flags.
    expect(withPermissions('codex', 'full', ['codex', 'resume', 'id'], {}).command).toEqual([
      'codex',
      '--sandbox',
      'danger-full-access',
      'resume',
      'id',
    ]);
    expect(withPermissions('grok', 'edit', ['grok'], {}).command).toEqual([
      'grok',
      '--permission-mode',
      'acceptEdits',
    ]);
    expect(withPermissions('antigravity', 'full', ['agy'], {}).command).toEqual([
      'agy',
      '--dangerously-skip-permissions',
    ]);
  });

  it("leaves the CLI alone for 'cli', shells, and flags the user already set", () => {
    expect(withPermissions('claude', 'cli', ['claude'], {}).command).toEqual(['claude']);
    expect(withPermissions('shell', 'full', ['cmd.exe'], {}).command).toEqual(['cmd.exe']);
    const own = ['claude', '--permission-mode', 'acceptEdits'];
    expect(withPermissions('claude', 'read', own, {}).command).toEqual(own);
  });

  it('sets OpenCode through its permission config, merged with existing config', () => {
    const { env } = withPermissions('opencode', 'read', ['opencode'], {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { projectmanager: {} } }),
    });
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      mcp: { projectmanager: {} },
      permission: { edit: 'deny', bash: 'ask', webfetch: 'allow' },
    });
  });

  it('resolves per-CLI overrides against the global level', () => {
    const perms = {
      global: 'edit' as const,
      providers: { codex: 'read' as const, grok: 'inherit' as const },
    };
    expect(effectiveLevel(perms, 'codex')).toBe('read');
    expect(effectiveLevel(perms, 'grok')).toBe('edit');
    expect(effectiveLevel(perms, 'claude')).toBe('edit');
  });

  it('Grok one-shot runs now honour the chosen level', () => {
    expect(buildDispatchArgv(getProvider('grok')!, 'task', 'read')).toEqual([
      'grok',
      '--permission-mode',
      'plan',
      '-p',
      'task',
    ]);
  });

  it('stores settings via the API and rejects unknown CLIs or levels', async () => {
    const app = createApp(openDb(':memory:'));
    const call = (method: string, body?: unknown) =>
      app.request('/api/agents/permissions', {
        method,
        headers: { host: 'localhost', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    expect(await (await call('GET')).json()).toEqual({ global: 'cli', providers: {} });
    const value = { global: 'edit', providers: { codex: 'read', claude: 'inherit' } };
    expect((await call('PUT', value)).status).toBe(200);
    expect(await (await call('GET')).json()).toEqual(value);
    expect((await call('PUT', { global: 'edit', providers: { bogus: 'read' } })).status).toBe(400);
    expect((await call('PUT', { global: 'god', providers: {} })).status).toBe(400);
  });
});

describe('Claude Code mode across a relaunch', () => {
  const screen = (footer: string) =>
    `● Done.\n\n> \n────\n  ${footer} (shift+tab to cycle) · ← 2 agents\n`;

  it('reads the mode from the footer', () => {
    expect(claudeModeOnScreen(screen('⏵⏵ auto mode on'))).toBe('auto');
    expect(claudeModeOnScreen(screen('⏵⏵ accept edits on'))).toBe('acceptEdits');
    expect(claudeModeOnScreen(screen('⏸ plan mode on'))).toBe('plan');
    expect(claudeModeOnScreen(screen('⏵⏵ bypass permissions on'))).toBe('bypassPermissions');
    expect(claudeModeOnScreen('● Done.\n> \n  ? for shortcuts\n')).toBeNull();
  });

  it('keeps the mode it was in instead of the Settings default, never raising to bypass', () => {
    const argv = ['claude', '--resume', 'x'];
    expect(withPermissions('claude', 'edit', argv, {}, 'auto').command).toEqual([
      'claude',
      '--permission-mode',
      'auto',
      '--resume',
      'x',
    ]);
    // Bypass only when Settings allows full access; otherwise the Settings level applies.
    expect(withPermissions('claude', 'edit', argv, {}, 'bypassPermissions').command).toEqual([
      'claude',
      '--permission-mode',
      'acceptEdits',
      '--resume',
      'x',
    ]);
    expect(withPermissions('claude', 'full', argv, {}, 'bypassPermissions').command[2]).toBe(
      'bypassPermissions',
    );
    // Nothing shown: the Settings level, as before.
    expect(withPermissions('claude', 'edit', argv, {}, null).command[2]).toBe('acceptEdits');
    // Other CLIs are untouched by a carried Claude mode.
    expect(withPermissions('codex', 'edit', ['codex'], {}, 'auto').command).toEqual([
      'codex',
      '--sandbox',
      'workspace-write',
    ]);
  });
});

describe('remembered Claude mode', () => {
  it('keeps the last seen mode and ignores a screen with no footer', async () => {
    const { rememberMode, rememberedMode } = await import('./permissions.js');
    rememberMode(901, 'auto');
    rememberMode(901, null);
    expect(rememberedMode(901)).toBe('auto');
    rememberMode(901, 'plan');
    expect(rememberedMode(901)).toBe('plan');
    expect(rememberedMode(902)).toBeNull();
  });
});
