// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { useOrchestratorRuns } from './useOrchestratorRuns';
vi.mock('../api', () => ({
  api: { orchestratorRuns: vi.fn(), orchestratorHistory: vi.fn(), orchestratorActionable: vi.fn() },
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const page = (id: number, nextBefore: number | null = null) => ({
  version: 1 as const,
  generatedAt: 'now',
  runs: [{ id }] as Awaited<ReturnType<typeof api.orchestratorRuns>>['runs'],
  historyIds: [id],
  nextBefore,
});
it('fences late owner responses and retains populated data after failed refresh', async () => {
  let resolve!: (value: ReturnType<typeof page>) => void;
  vi.mocked(api.orchestratorRuns)
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce(page(2));
  const { result, rerender } = renderHook(
    ({ owner, refresh }) => useOrchestratorRuns(owner, refresh, false),
    { initialProps: { owner: 'one', refresh: 0 } },
  );
  rerender({ owner: 'two', refresh: 0 });
  await waitFor(() => expect(result.current.runs[0]?.id).toBe(2));
  await act(async () => {
    resolve(page(1));
  });
  expect(result.current.runs[0]?.id).toBe(2);
  vi.mocked(api.orchestratorRuns).mockRejectedValueOnce(new Error('Offline'));
  rerender({ owner: 'two', refresh: 1 });
  await waitFor(() => expect(result.current.error).toBe('Offline'));
  expect(result.current.runs[0]?.id).toBe(2);
});
it('pages with the returned identity cursor and resets history on owner change', async () => {
  vi.mocked(api.orchestratorRuns)
    .mockResolvedValueOnce(page(40, 40))
    .mockResolvedValueOnce(page(20))
    .mockResolvedValueOnce(page(40, 40))
    .mockResolvedValueOnce(page(90));
  const { result, rerender } = renderHook(({ owner }) => useOrchestratorRuns(owner, 0, false), {
    initialProps: { owner: 'one' },
  });
  await waitFor(() => expect(result.current.next).toBeDefined());
  act(() => result.current.next!());
  await waitFor(() => expect(result.current.runs[0]?.id).toBe(20));
  expect(api.orchestratorRuns).toHaveBeenLastCalledWith('one', 40, undefined);
  act(() => result.current.previous!());
  await waitFor(() => expect(result.current.runs[0]?.id).toBe(40));
  rerender({ owner: 'two' });
  await waitFor(() => expect(result.current.runs[0]?.id).toBe(90));
  expect(api.orchestratorRuns).toHaveBeenLastCalledWith('two', undefined, undefined);
  expect(result.current.page).toBe(1);
});

it('allows returning from a failed history page rather than leaving navigation disabled', async () => {
  vi.mocked(api.orchestratorRuns)
    .mockResolvedValueOnce(page(40, 40))
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce(page(40, 40));
  const { result } = renderHook(() => useOrchestratorRuns('one', 0, false));
  await waitFor(() => expect(result.current.next).toBeDefined());
  act(() => result.current.next!());
  await waitFor(() => expect(result.current.error).toBe('Offline'));
  expect(result.current.loading).toBe(false);
  expect(result.current.previous).toBeDefined();
  act(() => result.current.previous!());
  await waitFor(() => expect(result.current.runs[0]?.id).toBe(40));
  expect(result.current.error).toBe('');
});

it('passes a historical link identity and reports a missing owned run', async () => {
  vi.mocked(api.orchestratorRuns)
    .mockResolvedValueOnce({ ...page(3), focusFound: true })
    .mockResolvedValueOnce({ ...page(40), focusFound: false });
  const { result, rerender } = renderHook(
    ({ focus }) => useOrchestratorRuns('one', 0, false, focus),
    { initialProps: { focus: 3 } },
  );
  await waitFor(() => expect(result.current.runs[0]?.id).toBe(3));
  expect(api.orchestratorRuns).toHaveBeenLastCalledWith('one', undefined, 3);
  rerender({ focus: 99 });
  expect(result.current.runs).toEqual([]);
  await waitFor(() =>
    expect(result.current.error).toBe('Linked run was not found in this Orchestrator.'),
  );
  expect(api.orchestratorRuns).toHaveBeenLastCalledWith('one', undefined, 99);
});

it('keeps complete actionable counts across pages and fences a changed feed kind', async () => {
  const summary = {
    total: 50,
    live: 25,
    awaitingReview: 25,
    failedReview: 3,
    ownedLive: 2,
    ownedReview: 1,
  };
  let resolve!: (value: ReturnType<typeof page>) => void;
  vi.mocked(api.orchestratorActionable)
    .mockResolvedValueOnce({ ...page(40, 40), summary })
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce({ ...page(90), summary });
  const { result, rerender } = renderHook(
    ({ kind }: { kind: 'live' | 'review' }) =>
      useOrchestratorRuns('one', 0, false, undefined, kind),
    { initialProps: { kind: 'live' as 'live' | 'review' } },
  );
  await waitFor(() => expect(result.current.next).toBeDefined());
  expect(result.current.summary?.live).toBe(25);
  act(() => result.current.next!());
  expect(api.orchestratorActionable).toHaveBeenLastCalledWith('one', 40, 'live');
  rerender({ kind: 'review' });
  await waitFor(() => expect(result.current.runs[0]?.id).toBe(90));
  expect(result.current.page).toBe(1);
  expect(result.current.summary?.awaitingReview).toBe(25);
  await act(async () => {
    resolve(page(20));
  });
  expect(result.current.runs[0]?.id).toBe(90);
  expect(api.orchestratorActionable).toHaveBeenLastCalledWith('one', undefined, 'review');
});
