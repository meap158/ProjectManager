import { startRunHost } from './runDaemon.js';

const [flag, dataDir, ...extra] = process.argv.slice(2);
if (flag !== '--data-dir' || !dataDir || extra.length)
  throw new Error('Usage: runHostMain --data-dir <folder>');
const host = await startRunHost(dataDir);
const stop = () => {
  void host
    .shutdown()
    .then((stopped) => {
      if (stopped) process.exit(0);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
