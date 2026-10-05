import path from 'node:path';
import { expect, it } from 'vitest';
import { buildDispatchArgv, buildInteractiveArgv, getProvider } from './providers.js';

it('attaches image paths as separate native arguments without shell interpolation', () => {
  const images = [path.resolve('image one.png'), path.resolve('image two.jpg')];
  const codex = buildDispatchArgv(getProvider('codex')!, 'Task', 'edit', images);
  expect(codex).toEqual([
    'codex',
    'exec',
    '--sandbox',
    'workspace-write',
    '--image',
    images[0],
    '--image',
    images[1],
    'Task',
  ]);
  const claude = buildInteractiveArgv(getProvider('claude')!, { prompt: 'Task', images });
  expect(claude).toEqual(['claude', '--add-dir', path.dirname(images[0]!), '--', 'Task']);
  const opencode = buildDispatchArgv(getProvider('opencode')!, 'Task', 'edit', images);
  expect(opencode).toEqual(['opencode', 'run', '--file', images[0], '--file', images[1], 'Task']);
  expect(buildInteractiveArgv(getProvider('opencode')!, { prompt: 'Task', images })).not.toContain(
    '--file',
  );
});
