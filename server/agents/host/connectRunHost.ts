import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { processEnv } from '../proc.js';
import { readRunRendezvous } from './runDaemon.js';
import { RunClient } from './runClient.js';

const starting = new Map<string, Promise<void>>();

/** Connect only to published credentials. Existing broken ownership never triggers replacement. */
export async function connectRunHost(
  dataDir: string,
  start: (directory: string) => Promise<void> = startRunHostProcess,
): Promise<RunClient> {
  mkdirSync(dataDir, { recursive: true });
  const directory = realpathSync(dataDir);
  const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
  let published: ReturnType<typeof readRunRendezvous> | undefined;
  try {
    published = readRunRendezvous(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (published) return authenticate(published);
  let pending = starting.get(key);
  if (!pending) {
    pending = startAndWait(directory, start).finally(() => starting.delete(key));
    starting.set(key, pending);
  }
  await pending;
  return authenticate(readRunRendezvous(directory));
}

async function startAndWait(directory: string, start: (directory: string) => Promise<void>) {
  await start(directory);
  const deadline = Date.now() + 10000;
  while (true) {
    try {
      const client = await authenticate(readRunRendezvous(directory));
      client.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function authenticate(connection: ReturnType<typeof readRunRendezvous>) {
  const client = await RunClient.connect(connection.address, connection.token, 2000);
  if (client.hostInstance !== connection.instance) {
    client.close();
    throw new Error('Run host identity mismatch');
  }
  return client;
}

/** An intermediate exits before dispatch: the daemon survives server-tree termination. */
async function startRunHostProcess(dataDir: string): Promise<void> {
  const script = fileURLToPath(
    new URL(`./runHostMain${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url),
  );
  const loader = script.endsWith('.ts')
    ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href]
    : [];
  const argv = [process.execPath, ...loader, script, '--data-dir', dataDir];
  const source = `const [cmd,...args]=JSON.parse(process.argv[1]);
    const child=require('node:child_process').spawn(cmd,args,{detached:true,stdio:'ignore',windowsHide:true});
    child.once('error',()=>process.exit(1));child.once('spawn',()=>{child.unref();});`;
  const env = processEnv();
  delete env.PM_LAUNCHER_PID;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source, JSON.stringify(argv)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Run host startup failed')),
    );
  });
}
