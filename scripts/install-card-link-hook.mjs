#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
const execute = promisify(execFile);

/** Explicit, per-repository installation; never overwrites a hook or changes Git config. */
export async function installCardLinkHook(project) {
  const cwd = await realpath(project);
  const git = async (args) =>
    (await execute('git', args, { cwd, windowsHide: true, timeout: 15_000 })).stdout.trim();
  const top = await realpath(await git(['rev-parse', '--show-toplevel']));
  if (top.toLowerCase() !== cwd.toLowerCase())
    throw Error('Pass the repository root, not a subfolder');
  const configured = await git(['config', '--get', 'core.hooksPath']).catch((error) => {
    if (error.code === 1) return '';
    throw error;
  });
  if (configured)
    throw Error(
      'core.hooksPath is configured. Install the template manually in your hook manager.',
    );
  const common = await realpath(path.resolve(cwd, await git(['rev-parse', '--git-common-dir'])));
  const hooks = path.join(common, 'hooks');
  const existing = await lstat(hooks).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw Error('Refusing a linked hooks directory');
  await mkdir(hooks, { recursive: true });
  if ((await realpath(hooks)) !== hooks) throw Error('Refusing a redirected hooks directory');
  const file = path.join(hooks, 'commit-msg');
  const template = await readFile(new URL('./templates/commit-msg.cjs', import.meta.url));
  await writeFile(file, template, { flag: 'wx', mode: 0o755 });
  return file;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--project') {
    console.error('Usage: node scripts/install-card-link-hook.mjs --project <repository-root>');
    process.exitCode = 1;
  } else {
    try {
      console.log(`Installed warn-only hook: ${await installCardLinkHook(process.argv[3])}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
