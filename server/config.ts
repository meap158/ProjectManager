import path from 'node:path';

// Runtime configuration, read from the environment. The launcher (scripts/launch.mjs) loads .env,
// picks a free port and passes it in as PORT, so the server never guesses ports itself.

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`${name} must be a port number (1-65535), got "${raw}"`);
  }
  return value;
}

export const config = {
  port: intFromEnv('PORT', 5180),
  host: process.env.HOST || '127.0.0.1',
  dataDir: path.resolve(process.env.DATA_DIR || 'data'),
  isProduction: process.env.NODE_ENV === 'production',
};
