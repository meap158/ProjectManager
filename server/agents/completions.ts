// Composer suggestions for the chat view (PM-117): the CLI's slash commands (built in, plus your
// own custom commands and skills) and @-mentionable project files. Read from where the CLIs
// themselves keep them; file matching runs here so a phone never downloads a whole file list.

import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SlashCommand } from '../../shared/types.js';
import { listSourceFiles } from '../analysis/fileList.js';

const builtin = (list: [string, string][]): SlashCommand[] =>
  list.map(([name, description]) => ({ name, description, source: 'builtin' }));

/** The CLIs' built-in commands (their own /help), most used first. */
const BUILT_IN: Record<string, SlashCommand[]> = {
  claude: builtin([
    ['clear', 'Clear the conversation and start fresh'],
    ['compact', 'Summarise the conversation to free up context'],
    ['context', 'Show what fills the context window'],
    ['model', 'Choose the model'],
    ['resume', 'Resume an earlier conversation'],
    ['rewind', 'Rewind the conversation and/or code'],
    ['review', 'Review a pull request'],
    ['security-review', 'Security review of the pending changes'],
    ['init', 'Create a CLAUDE.md for this project'],
    ['memory', 'Edit CLAUDE.md memory files'],
    ['agents', 'Manage subagents'],
    ['mcp', 'Manage MCP servers'],
    ['permissions', 'View or change tool permissions'],
    ['hooks', 'Manage hooks'],
    ['config', 'Open settings'],
    ['status', 'Version, model, account and connectivity'],
    ['usage', 'Plan usage limits'],
    ['cost', 'Token usage of this session'],
    ['todos', 'Show the current todo list'],
    ['export', 'Export the conversation'],
    ['add-dir', 'Add a working directory'],
    ['output-style', 'Choose an output style'],
    ['plugin', 'Manage plugins'],
    ['doctor', 'Check the installation'],
    ['help', 'Show help and all commands'],
    ['exit', 'Exit the CLI'],
  ]),
  codex: builtin([
    ['new', 'Start a new conversation'],
    ['compact', 'Summarise the conversation to free up context'],
    ['model', 'Choose the model and reasoning effort'],
    ['approvals', 'Choose what Codex may do without asking'],
    ['review', 'Review the current changes'],
    ['diff', 'Show the git diff, including untracked files'],
    ['undo', 'Undo the last turn'],
    ['init', 'Create an AGENTS.md for this project'],
    ['mention', 'Mention a file'],
    ['status', 'Session configuration and token usage'],
    ['mcp', 'List configured MCP tools'],
    ['quit', 'Exit Codex'],
  ]),
};

/** `description:` from a Markdown file's front matter, else its first line of text. */
async function describe(file: string): Promise<{ name?: string; description: string }> {
  const text = await readFile(file, 'utf8').catch(() => '');
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const field = (key: string) =>
    new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'm').exec(front)?.[1]?.trim();
  const body = text.slice(front ? text.indexOf('---', 3) + 3 : 0);
  const firstLine =
    body
      .split('\n')
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find(Boolean) ?? '';
  return { name: field('name'), description: (field('description') ?? firstLine).slice(0, 140) };
}

/** Markdown commands under `dir` (sub-folders namespace them: frontend/test → frontend:test). */
async function commandsIn(
  dir: string,
  source: SlashCommand['source'],
  prefix = '',
): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  const walk = async (folder: string, ns: string[]) => {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory() && ns.length < 3) await walk(full, [...ns, entry.name]);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const base = entry.name.slice(0, -3);
        out.push({
          name: prefix + [...ns, base].join(':'),
          description: (await describe(full)).description,
          source,
        });
      }
    }
  };
  await walk(dir, []);
  return out;
}

/** Skills (folders with a SKILL.md): invoked as /<name>. */
async function skillsIn(dir: string): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'SKILL.md');
    const info = await describe(file);
    if (info.description || info.name)
      out.push({ name: info.name ?? entry.name, description: info.description, source: 'skill' });
  }
  return out;
}

const commandCache = new Map<string, { at: number; value: Promise<SlashCommand[]> }>();

/** Every slash command a session's CLI offers, built-ins first; cached for a minute. */
export function slashCommands(
  providerId: string,
  cwd: string,
  home = os.homedir(),
): Promise<SlashCommand[]> {
  const key = `${providerId}\0${cwd}`;
  const hit = commandCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = (async () => {
    const custom =
      providerId === 'claude'
        ? [
            ...(await commandsIn(path.join(cwd, '.claude', 'commands'), 'project')),
            ...(await commandsIn(path.join(home, '.claude', 'commands'), 'user')),
            ...(await skillsIn(path.join(cwd, '.claude', 'skills'))),
            ...(await skillsIn(path.join(home, '.claude', 'skills'))),
          ]
        : providerId === 'codex'
          ? await commandsIn(path.join(home, '.codex', 'prompts'), 'user', 'prompts:')
          : [];
    const seen = new Set<string>();
    return [...(BUILT_IN[providerId] ?? []), ...custom].filter((c) =>
      seen.has(c.name) ? false : (seen.add(c.name), true),
    );
  })();
  commandCache.set(key, { at: Date.now(), value });
  return value;
}

const fileCache = new Map<string, { at: number; value: Promise<string[]> }>();

/** Project files matching what follows an @, best matches first (name hits before path hits). */
export async function suggestFiles(cwd: string, query: string, limit = 20): Promise<string[]> {
  let hit = fileCache.get(cwd);
  if (!hit || Date.now() - hit.at > 60_000) {
    const value = listSourceFiles(cwd).then(
      (list) => list.files.map((f) => f.replace(/\\/g, '/')),
      () => [] as string[],
    );
    hit = { at: Date.now(), value };
    fileCache.set(cwd, hit);
  }
  const files = await hit.value;
  const q = query.toLowerCase();
  if (!q) return files.slice(0, limit);
  const scored: { file: string; score: number }[] = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : lower.includes(q) ? 2 : -1;
    if (score >= 0) scored.push({ file, score });
    if (scored.length > 2000) break;
  }
  return scored
    .sort((a, b) => a.score - b.score || a.file.length - b.file.length)
    .slice(0, limit)
    .map((s) => s.file);
}
