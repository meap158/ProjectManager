import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Bootstrap applies budget to its own process before it creates the real worker. */
export function budgetedRunArgv(argv: string[], threads: number): string[] {
  if (!Number.isSafeInteger(threads) || threads < 1) throw new Error('Invalid CPU thread budget');
  const script = fileURLToPath(
    new URL(`./budgetedRunMain${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url),
  );
  const loader = script.endsWith('.ts')
    ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href]
    : [];
  return [
    process.execPath,
    ...loader,
    script,
    String(threads),
    Buffer.from(JSON.stringify(argv)).toString('base64'),
  ];
}
