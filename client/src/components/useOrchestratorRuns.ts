import { useEffect, useState } from 'react';
import { api, type OrchestratorRunPage } from '../api';
import { serialPoll } from '../lib/serialPoll';

/** Owner and cursor travel with results so a late response cannot populate another workspace. */
export function useOrchestratorRuns(
  owner: string | undefined,
  refresh: number,
  paused: boolean,
  focus?: number,
  kind: 'legacy' | 'history' | 'live' | 'review' = 'legacy',
) {
  const [selection, setSelection] = useState<{
    owner: string;
    kind: string;
    cursors: (number | undefined)[];
  }>({
    owner: '',
    kind: 'legacy',
    cursors: [undefined],
  });
  const cursors =
    selection.owner === owner && selection.kind === kind ? selection.cursors : [undefined];
  const before = cursors.at(-1);
  const [result, setResult] = useState<{
    owner: string;
    kind: string;
    before?: number;
    focus?: number;
    data: OrchestratorRunPage;
  } | null>(null);
  const [failure, setFailure] = useState<{
    owner: string;
    kind: string;
    before?: number;
    focus?: number;
    message: string;
  } | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!owner || paused) return;
    let active = true;
    const stop = serialPoll(async () => {
      if (active) setPending(true);
      try {
        const data = await (kind === 'legacy'
          ? api.orchestratorRuns(owner, before, focus)
          : kind === 'history'
            ? api.orchestratorHistory(owner, before, focus)
            : api.orchestratorActionable(owner, before, kind));
        if (active) {
          setResult({ owner, kind, before, focus, data });
          setFailure(null);
        }
      } catch (error) {
        if (active) setFailure({ owner, kind, before, focus, message: (error as Error).message });
      } finally {
        if (active) setPending(false);
      }
    }, 5000);
    return () => {
      active = false;
      stop();
    };
  }, [owner, before, refresh, paused, focus, kind]);
  const data =
    result &&
    result.owner === owner &&
    result.kind === kind &&
    result.before === before &&
    result.focus === focus
      ? result.data
      : null;
  const error =
    failure &&
    failure.owner === owner &&
    failure.kind === kind &&
    failure.before === before &&
    failure.focus === focus
      ? failure.message
      : '';
  return {
    runs: data?.runs ?? [],
    // Complete metadata is independent of the detail cursor; retain it during navigation.
    summary:
      result && result.owner === owner && result.kind === kind ? result.data.summary : undefined,
    liveAssignments:
      result && result.owner === owner && result.kind === kind
        ? result.data.liveAssignments
        : undefined,
    error:
      error ||
      (focus !== undefined && data?.focusFound === false
        ? 'Linked run was not found in this Orchestrator.'
        : ''),
    loading: pending || (!data && !error),
    next:
      data?.nextBefore == null
        ? undefined
        : () => setSelection({ owner: owner!, kind, cursors: [...cursors, data.nextBefore!] }),
    previous:
      cursors.length < 2
        ? undefined
        : () => setSelection({ owner: owner!, kind, cursors: cursors.slice(0, -1) }),
    page: cursors.length,
  };
}
