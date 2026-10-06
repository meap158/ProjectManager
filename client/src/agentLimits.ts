import { useEffect, useState } from 'react';
import type { ProviderLimits } from '../../shared/limits';
import { api } from './api';

/**
 * Plan usage limits the agent CLIs record locally (PM-17), with the clock they were read at (for
 * "resets in …"). Refreshed every minute; a failed read keeps what was shown (advisory data).
 */
export function useAgentLimits(): { list: ProviderLimits[]; now: number } {
  const [limits, setLimits] = useState<{ list: ProviderLimits[]; now: number }>({
    list: [],
    now: 0,
  });
  useEffect(() => {
    let active = true;
    const load = () =>
      api.agentLimits().then(
        (list) => active && setLimits({ list, now: Date.now() }),
        () => undefined,
      );
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return limits;
}
