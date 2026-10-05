// Tests for one-click agent CLI installs: recipe selection per OS, the install
// lifecycle with injected recipes (no network), guards, cancel, and boot state.

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentInstall, InstallRecipe } from '../../shared/types.js';
import { createApp } from '../app.js';
import { openDb, type Db } from '../db.js';
import { fetchScript, recipeFor } from './install.js';
import { getProvider } from './providers.js';
import { AgentSupervisor } from './supervisor.js';

const HOST = { host: 'localhost:5180' };
const NODE = process.execPath;

const ECHO_RECIPE: InstallRecipe = {
  label: 'test echo',
  detail: 'test only',
  docUrl: 'https://example.invalid',
  kind: 'command',
  command: [NODE, '-e', `console.log('installed-ok')`],
};
// Node executes a piped stdin script when given no file, on every OS.
const SCRIPT_RECIPE: InstallRecipe = {
  label: 'test script',
  detail: 'test only',
  docUrl: 'https://example.invalid',
  kind: 'script',
  scriptUrl: `data:text/plain,console.log('script-ok')`,
  interpreter: [NODE],
};
const SLEEP_RECIPE: InstallRecipe = {
  label: 'test sleep',
  detail: 'test only',
  docUrl: 'https://example.invalid',
  kind: 'command',
  command: [NODE, '-e', `setTimeout(()=>{},30000)`],
};

function recipes(extra: Record<string, InstallRecipe> = {}) {
  return { codex: ECHO_RECIPE, ...extra };
}

async function waitFor<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  label: string,
): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (pred(v)) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('recipeFor', () => {
  it('picks the official method per OS', () => {
    expect(recipeFor(getProvider('claude')!, 'win32')?.scriptUrl).toBe(
      'https://claude.ai/install.ps1',
    );
    expect(recipeFor(getProvider('claude')!, 'darwin')?.scriptUrl).toBe(
      'https://claude.ai/install.sh',
    );
    expect(recipeFor(getProvider('codex')!, 'linux')?.scriptUrl).toBe(
      'https://chatgpt.com/codex/install.sh',
    );
    expect(recipeFor(getProvider('grok')!, 'win32')?.scriptUrl).toBe(
      'https://x.ai/cli/install.ps1',
    );
    expect(recipeFor(getProvider('grok')!, 'linux')?.scriptUrl).toBe('https://x.ai/cli/install.sh');
    expect(recipeFor(getProvider('opencode')!, 'win32')?.command).toEqual([
      'npm',
      'install',
      '-g',
      'opencode-ai@latest',
    ]);
    expect(recipeFor(getProvider('gemini')!, 'linux')?.command).toEqual([
      'npm',
      'install',
      '-g',
      '@google/gemini-cli',
    ]);
    expect(recipeFor(getProvider('shell')!)).toBeNull();
    expect(recipeFor(getProvider('custom')!)).toBeNull();
    expect(recipeFor(getProvider('claude')!, 'sunos')).toBeNull();
  });

  it('fetches scripts with caps', async () => {
    const script = await fetchScript(`data:text/plain,console.log('x')`);
    expect(script.toString('utf8')).toContain(`console.log('x')`);
    await expect(fetchScript('http://example.invalid/x.sh')).rejects.toThrow(/plain HTTP/);
    await expect(fetchScript('not a url')).rejects.toThrow();
  });
});

describe('install routes', () => {
  let tmp: string;
  let app: ReturnType<typeof createApp>;
  let call: (method: string, url: string, body?: unknown) => Promise<Response>;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'pm-install-routes-'));
    app = createApp(openDb(':memory:'), { dataDir: tmp });
    call = (method: string, url: string, body?: unknown) =>
      app.request(`/api${url}`, {
        method,
        headers: {
          ...HOST,
          ...(method === 'GET' || method === 'DELETE'
            ? {}
            : { 'content-type': 'application/json' }),
        },
        body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
      });
  });
  afterAll(async () => {
    await app.supervisor.shutdown();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('rejects unknown providers and recipe-less ids', async () => {
    expect((await call('POST', '/agents/providers/nope/install')).status).toBe(404);
    expect((await call('POST', '/agents/providers/shell/install')).status).toBe(400);
    expect((await call('POST', '/agents/providers/custom/install')).status).toBe(400);
    expect((await call('GET', '/agent-installs/999/output?after=0')).status).toBe(404);
    expect((await call('DELETE', '/agent-installs/999')).status).toBe(404);
  });

  it('exposes the recipe in provider statuses', async () => {
    const providers = (await (await call('GET', '/agents/providers')).json()) as {
      id: string;
      install: InstallRecipe | null;
    }[];
    const claude = providers.find((p) => p.id === 'claude')!;
    expect(claude.install?.scriptUrl).toContain('claude.ai/install.');
    expect(claude.install?.docUrl).toContain('docs.anthropic.com');
    expect(providers.find((p) => p.id === 'shell')?.install).toBeNull();
  });
});

describe('install lifecycle', () => {
  let tmp: string;
  let logs: string;
  let db: Db;
  let sup: AgentSupervisor;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'pm-install-'));
    logs = path.join(tmp, 'logs');
    db = openDb(path.join(tmp, 'db'));
    sup = new AgentSupervisor(db, logs, { installRecipes: recipes() });
  });
  afterAll(async () => {
    await sup.shutdown();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('runs a command recipe to success and serves its output', async () => {
    const created = await sup.startInstall('codex');
    expect(created.status).toBe('running');
    const done = await waitFor(
      async () => sup.getInstall(created.id)!,
      (i) => i.status !== 'running',
      'install',
    );
    expect(done.status).toBe('succeeded');
    expect(done.exitCode).toBe(0);
    const out = sup.readInstallOutput(created.id, 0)!;
    expect(out.data).toContain('installed-ok');
    expect(out.nextOffset).toBeGreaterThan(0);
    expect(out.running).toBe(false);
    expect(await sup.removeInstall(created.id)).toBe(true);
    expect(sup.getInstall(created.id)).toBeNull();
  }, 20_000);

  it('pipes a downloaded script to the interpreter', async () => {
    const sup2 = new AgentSupervisor(db, logs, {
      installRecipes: { gemini: SCRIPT_RECIPE },
    });
    try {
      const created = await sup2.startInstall('gemini');
      const done = await waitFor(
        async () => sup2.getInstall(created.id)!,
        (i) => i.status !== 'running',
        'script install',
      );
      expect(done.status).toBe('succeeded');
      expect(sup2.readInstallOutput(created.id, 0)!.data).toContain('script-ok');
      await sup2.removeInstall(created.id);
    } finally {
      await sup2.shutdown();
    }
  }, 20_000);

  it('records failures with the exit code', async () => {
    const sup2 = new AgentSupervisor(db, logs, {
      installRecipes: { grok: { ...ECHO_RECIPE, command: [NODE, '-e', 'process.exit(3)'] } },
    });
    try {
      const created = await sup2.startInstall('grok');
      const done = await waitFor(
        async () => sup2.getInstall(created.id)!,
        (i) => i.status !== 'running',
        'failed install',
      );
      expect(done.status).toBe('failed');
      expect(done.exitCode).toBe(3);
      expect(done.error).toContain('code 3');
      await sup2.removeInstall(created.id);
    } finally {
      await sup2.shutdown();
    }
  }, 20_000);

  it('rejects a second install while one runs, and cancels it', async () => {
    const sup2 = new AgentSupervisor(db, logs, {
      installRecipes: { opencode: SLEEP_RECIPE },
    });
    try {
      const created = await sup2.startInstall('opencode');
      await expect(sup2.startInstall('opencode')).rejects.toThrow(/already running/);
      const cancelled = (await sup2.cancelInstall(created.id)) as AgentInstall;
      expect(['killed', 'running']).toContain(cancelled.status);
      const settled = await waitFor(
        async () => sup2.getInstall(created.id)!,
        (i) => i.status !== 'running',
        'cancel',
      );
      expect(settled.status).toBe('killed');
      expect(await sup2.removeInstall(created.id)).toBe(true);
    } finally {
      await sup2.shutdown();
    }
  }, 20_000);

  it('marks running installs failed across a restart', async () => {
    const sup2 = new AgentSupervisor(db, logs, {
      installRecipes: { opencode: SLEEP_RECIPE },
    });
    const created = await sup2.startInstall('opencode');
    await sup2.shutdown();
    const sup3 = new AgentSupervisor(db, logs);
    try {
      const marked = sup3.getInstall(created.id)!;
      expect(marked.status).toBe('failed');
      expect(marked.error).toContain('shut down');
      await sup3.removeInstall(created.id);
    } finally {
      await sup3.shutdown();
    }
  }, 20_000);
});
