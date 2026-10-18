import { afterEach, expect, it, vi } from 'vitest';
import { api } from './api';
afterEach(() => vi.unstubAllGlobals());
it('shares concurrent project reads then refetches instead of keeping stale data', async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const a = api.listProjects();
  const b = api.listProjects();
  expect(fetcher).toHaveBeenCalledTimes(1);
  resolve(new Response('[]', { headers: { 'Content-Type': 'application/json' } }));
  expect(await a).toEqual([]);
  expect(await b).toEqual([]);
  const c = api.listProjects();
  expect(fetcher).toHaveBeenCalledTimes(2);
  resolve(new Response('[]'));
  await c;
});
it('does not retain failed reads', async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(new Response('[]'));
  vi.stubGlobal('fetch', fetcher);
  await expect(api.listProjects()).rejects.toThrow('network');
  expect(await api.listProjects()).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
