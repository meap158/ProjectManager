// Tests for the CLI-integration layer: how provider argv is built, how Windows npm shims are
// unwrapped, PTY sessions, live streaming, and recording what a run changed.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRun, AgentSession } from '../../shared/types.js';
import { createApp } from '../app.js';
import { openDb } from '../db.js';
import { processEnv, ptyAvailable } from './proc.js';
import { buildDispatchArgv, getProvider, supportsAutonomy } from './providers.js';
import { parseNpmShim, resolveArgv } from './resolve.js';

const NODE = process.execPath;
const PROMPT = 'Task PM-1: do it\n\nmulti-line "quoted" & <special>';

describe('buildDispatchArgv', () => {
  it('puts the binary first and autonomy flags before the prompt', () => {
    expect(buildDispatchArgv(getProvider('claude')!, PROMPT, 'edit')).toEqual([
      'claude',
      '--permission-mode',
      'acceptEdits',
      '-p',
      PROMPT,
    ]);
    expect(buildDispatchArgv(getProvider('codex')!, PROMPT, 'full')).toEqual([
      'codex',
      'exec',
      '--sandbox',
      'danger-full-access',
      PROMPT,
    ]);
    expect(buildDispatchArgv(getProvider('gemini')!, PROMPT, 'read')).toEqual([
      'gemini',
      '--approval-mode',
      'plan',
      '-p',
      PROMPT,
    ]);
    expect(buildDispatchArgv(getProvider('opencode')!, PROMPT, 'edit')).toEqual([
      'opencode',
      'run',
      PROMPT,
    ]);
  });

  it('knows which autonomy levels each provider supports', () => {
    expect(supportsAutonomy(getProvider('opencode')!, 'read')).toBe(false);
    expect(supportsAutonomy(getProvider('claude')!, 'read')).toBe(true);
  });
});

describe('agent environment', () => {
  it("strips the launching session's markers but keeps user configuration", () => {
    const saved = { ...process.env };
    Object.assign(process.env, {
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_MODEL: 'x',
    });
    try {
      const env = processEnv({ EXTRA: 'y' });
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
      expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
      expect(env.CLAUDE_CODE_MESSAGING_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
      expect(env.ANTHROPIC_MODEL).toBe('x');
      expect(env.EXTRA).toBe('y');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe('Windows npm shim unwrapping', () => {
  const dir = path.join('C:', 'Users', 'me', 'AppData', 'Roaming', 'npm');

  it('runs node-script shims with node, keeping argv intact (no cmd.exe)', () => {
    const shim = `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`;
    expect(parseNpmShim(shim, dir)).toEqual([
      process.execPath,
      path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    ]);
  });

  it('runs native-binary shims directly', () => {
    const shim = `@ECHO off\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n`;
    expect(parseNpmShim(shim, dir)).toEqual([
      path.join(dir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    ]);
  });

  it('refuses batch files it cannot unwrap', () => {
    expect(parseNpmShim('@echo off\r\necho hi %*\r\n', dir)).toBeNull();
  });

  it('resolves the node binary itself to a launchable path', async () => {
    const argv = await resolveArgv([NODE, '-v']);
    expect(argv.at(-1)).toBe('-v');
    expect(execFileSync(argv[0]!, argv.slice(1)).toString()).toMatch(/^v\d+/);
  });
});

// ---- API-level: PTY sessions, streaming, run changes ------------------------------------------

let tmp: string;
let app: ReturnType<typeof createApp>;
let projectId: number;
let repo: string;

const call = (method: string, url: string, body?: unknown) =>
  app.request(`/api${url}`, {
    method,
    headers: {
      host: 'localhost:5180',
      ...(method === 'GET' || method === 'DELETE' ? {} : { 'content-type': 'application/json' }),
    },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
  });

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, label: string) {
  let last: T | undefined;
  for (let i = 0; i < 300; i++) {
    last = await fn();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `timed out waiting for ${label}; last value: ${JSON.stringify(last)?.slice(0, 600)}`,
  );
}

const output = async (id: number) =>
  ((await (await call('GET', `/agent-sessions/${id}/output?after=0`)).json()) as { data: string })
    .data;
const getRun = async (id: number) =>
  (await (await call('GET', `/agent-runs/${id}`)).json()) as AgentRun;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'pm-cli-'));
  repo = path.join(tmp, 'repo');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x.io', ...args], { cwd: repo });
  git('init', '-q');
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  app = createApp(openDb(':memory:'), { dataDir: tmp });
  const res = await call('POST', '/projects', { path: repo });
  projectId = ((await res.json()) as { id: number }).id;
}, 30_000);

afterAll(async () => {
  await app.supervisor.shutdown();
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!ptyAvailable())('PTY sessions', () => {
  it('defaults to a pseudo-terminal: stdin is a TTY, Enter is \\r, resize works', async () => {
    const script =
      `process.stdout.write('tty:'+process.stdin.isTTY+'\\n');` +
      `process.stdin.on('data',d=>{process.stdout.write('got:'+String(d).trim()+'\\n')})`;
    const created = (await (
      await call('POST', `/projects/${projectId}/agent-sessions`, {
        providerId: 'custom',
        command: [NODE, '-e', script],
        supervise: false,
      })
    ).json()) as AgentSession;
    expect(created.terminal).toBe('pty');
    expect(created.status).toBe('running');
    await waitFor(
      () => output(created.id),
      (d) => d.includes('tty:true'),
      'tty banner',
    );

    await call('POST', `/agent-sessions/${created.id}/input`, { data: 'ping\r' });
    await waitFor(
      () => output(created.id),
      (d) => d.includes('got:ping'),
      'pty echo',
    );

    const resized = await call('POST', `/agent-sessions/${created.id}/resize`, {
      cols: 100,
      rows: 40,
    });
    expect(resized.status).toBe(200);
    expect(
      (await call('POST', `/agent-sessions/${created.id}/resize`, { cols: 1, rows: 1 })).status,
    ).toBe(400);
    await call('DELETE', `/agent-sessions/${created.id}`);
  }, 60_000);
});

describe('live output stream', () => {
  it('streams session output as server-sent events', async () => {
    const created = (await (
      await call('POST', `/projects/${projectId}/agent-sessions`, {
        providerId: 'custom',
        command: [
          NODE,
          '-e',
          `setTimeout(()=>console.log('streamed-hello'),300);setInterval(()=>{},1000)`,
        ],
        supervise: false,
        terminal: 'pipe',
      })
    ).json()) as AgentSession;
    const res = await call('GET', `/agent-sessions/${created.id}/stream?after=0`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 10_000;
    while (!text.includes('streamed-hello') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain('event: output');
    expect(text).toContain('streamed-hello');
    await reader.cancel();
    await call('DELETE', `/agent-sessions/${created.id}`);
  }, 20_000);
});

describe('row id reuse', () => {
  it("a deleted session's late exit never touches a new session that reuses its id", async () => {
    const make = async (code: string) =>
      (await (
        await call('POST', `/projects/${projectId}/agent-sessions`, {
          providerId: 'custom',
          command: [NODE, '-e', code],
          supervise: false,
          terminal: 'pipe',
        })
      ).json()) as AgentSession;
    const first = await make(`console.log('first-session');setInterval(()=>{},1000)`);
    await waitFor(
      () => output(first.id),
      (d) => d.includes('first-session'),
      'first output',
    );
    await call('DELETE', `/agent-sessions/${first.id}`);
    const second = await make(`console.log('second-session');setInterval(()=>{},1000)`);
    expect(second.id).toBe(first.id); // SQLite reuses the id: the case under test.
    await waitFor(
      () => output(second.id),
      (d) => d.includes('second-session'),
      'new output',
    );
    await new Promise((r) => setTimeout(r, 1000)); // Let any late exit of the first one land.
    const after = (await (
      await call('GET', `/agent-sessions/${second.id}`)
    ).json()) as AgentSession;
    expect(after.status).toBe('running');
    // The new session's log never shows the deleted session's output.
    expect(await output(second.id)).not.toContain('first-session');
    await call('DELETE', `/agent-sessions/${second.id}`);
  }, 30_000);
});

describe('run change tracking and autonomy', () => {
  async function dispatch(title: string, body: Record<string, unknown>) {
    const card = (await (await call('POST', `/projects/${projectId}/cards`, { title })).json()) as {
      id: number;
    };
    const res = await call('POST', `/projects/${projectId}/cards/${card.id}/dispatch`, body);
    return { res, card };
  }

  it('records the files a run changed and the commits it made', async () => {
    const { res } = await dispatch('Write a file', {
      command: [
        NODE,
        '-e',
        `require('fs').writeFileSync('b.txt','new');require('fs').appendFileSync('a.txt','two')`,
      ],
    });
    expect(res.status).toBe(201);
    const run = (await res.json()) as AgentRun;
    expect(run.autonomy).toBe('edit');
    const done = await waitFor(
      () => getRun(run.id),
      (r) => r.status === 'succeeded',
      'run',
    );
    expect(done.changes).toEqual({ files: ['a.txt', 'b.txt'], commits: 0 });
  }, 30_000);

  it('flags a successful run that changed nothing', async () => {
    const { res } = await dispatch('No-op', { command: [NODE, '-e', `console.log('nothing')`] });
    const run = (await res.json()) as AgentRun;
    const done = await waitFor(
      () => getRun(run.id),
      (r) => r.status === 'succeeded',
      'run',
    );
    expect(done.changes).toEqual({ files: [], commits: 0 });
    const out = (await (await call('GET', `/agent-runs/${run.id}/output?after=0`)).json()) as {
      data: string;
    };
    expect(out.data).toContain('changed no files');
  }, 30_000);

  it('rejects autonomy levels a provider does not support', async () => {
    const { res } = await dispatch('Read-only opencode', {
      providerId: 'opencode',
      autonomy: 'read',
    });
    // Either "not on PATH" (CI) or "no read mode": both are 400 before anything spawns.
    expect(res.status).toBe(400);
    const { res: bad } = await dispatch('Bad autonomy', {
      command: [NODE, '-v'],
      autonomy: 'yolo',
    });
    expect(bad.status).toBe(400);
  });
});
