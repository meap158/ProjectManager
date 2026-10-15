import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { RunJournal } from './runJournal.js';
import { RunLauncher } from './runLauncher.js';
import { createRunServer } from './runServer.js';

export interface RunRendezvous {
  version: 1;
  instance: string;
  address: string;
  token: string;
}
export const runRendezvousFile = (dataDir: string) =>
  path.join(dataDir, 'run-host', 'connection.json');
export function readRunRendezvous(dataDir: string): RunRendezvous {
  const value = JSON.parse(readFileSync(runRendezvousFile(dataDir), 'utf8')) as RunRendezvous;
  if (
    value.version !== 1 ||
    typeof value.instance !== 'string' ||
    typeof value.address !== 'string' ||
    typeof value.token !== 'string'
  )
    throw new Error('Invalid run host rendezvous');
  return value;
}

/** Startup claims the local address before publishing credentials; it never removes a live/stale socket. */
export async function startRunHost(dataDir: string) {
  const directory = path.join(path.resolve(dataDir), 'run-host');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(directory, 0o700);
  const instance = randomUUID(),
    token = randomBytes(32).toString('hex');
  const canonical = realpathSync(directory);
  const hash = createHash('sha256')
    .update(process.platform === 'win32' ? canonical.toLowerCase() : canonical)
    .digest('hex')
    .slice(0, 24);
  const address =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\projectmanager-runs-${hash}`
      : path.join(directory, 'host.sock');
  const journal = new RunJournal(path.join(directory, 'journal.db'), instance);
  const launcher = new RunLauncher(journal, path.join(directory, 'logs'));
  const host = createRunServer(token, launcher, journal);
  try {
    await new Promise<void>((resolve, reject) => {
      host.server.once('error', reject);
      host.server.listen(address, () => {
        host.server.removeListener('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') chmodSync(address, 0o600);
    const connection: RunRendezvous = { version: 1, instance, address, token };
    const pending = path.join(directory, `${instance}.json.tmp`);
    writeFileSync(pending, JSON.stringify(connection), { mode: 0o600, flag: 'wx' });
    renameSync(pending, runRendezvousFile(dataDir));
    let shutdown: Promise<boolean> | undefined;
    return {
      connection,
      shutdown: () => {
        if (shutdown) return shutdown;
        host.drain();
        shutdown = (async () => {
          if (!(await launcher.stopAll())) {
            shutdown = undefined;
            return false;
          }
          host.disconnect();
          await new Promise<void>((resolve) => host.server.close(() => resolve()));
          journal.close();
          if (readRunRendezvous(dataDir).instance === instance)
            rmSync(runRendezvousFile(dataDir), { force: true });
          return true;
        })();
        return shutdown;
      },
    };
  } catch (error) {
    host.disconnect();
    host.server.close();
    journal.close();
    throw error;
  }
}
