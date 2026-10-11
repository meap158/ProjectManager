import { spawnSync } from 'node:child_process';

// A development server's inherited NODE_ENV must not ship development React code.
for (const args of [
  ['node_modules/vite/bin/vite.js', 'build'],
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json'],
]) {
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
