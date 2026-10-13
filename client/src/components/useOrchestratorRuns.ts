import { useEffect, useState } from 'react';
import { api } from '../api';
import { serialPoll } from '../lib/serialPoll';

/** Owner and cursor travel with results so a late response cannot populate another workspace. */
export function useOrchestratorRuns(owner: string | undefined, refresh: number, paused: boolean) {
  const [selection, setSelection] = useState<{ owner: string; cursors: (number | undefined)[] }>({
    owner: '',
    cursors: [undefined],
  });
  const cursors = selection.owner === owner ? selection.cursors : [undefined];
  const before = cursors.at(-1);
  const [result, setResult] = useState<{
    owner: string;
    before?: number;
    data: Awaited<ReturnType<typeof api.orchestratorRuns>>;
  } | null>(null);
  const [failure, setFailure] = useState<{
    owner: string;
    before?: number;
    message: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!owner || paused) return;
    let active = true;
    const stop = serialPoll(async () => {
      if (active) setPending(true);
      try {
        const data = await api.orchestratorRuns(owner, before);
        if (active) {
          setResult({ owner, before, data });
          setFailure(null);
        }
      } catch (error) {
        if (active) setFailure({ owner, before, message: (error as Error).message });
      } finally {
        if (active) setPending(false);
      }
    }, 5000);
    return () => {
      active = false;
      stop();
    };
  }, [owner, before, refresh, paused]);
  const data = result && result.owner === owner && result.before === before ? result.data : null;
  const error =
    failure && failure.owner === owner && failure.before === before ? failure.message : '';
  return {
    runs: data?.runs ?? [],
    error,
    loading: pending || (!data && !error),
    next:
      data?.nextBefore == null
        ? undefined
        : () => setSelection({ owner: owner!, cursors: [...cursors, data.nextBefore!] }),
    previous:
      cursors.length < 2
        ? undefined
        : () => setSelection({ owner: owner!, cursors: cursors.slice(0, -1) }),
    page: cursors.length,
  };
}
