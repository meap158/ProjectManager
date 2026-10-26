import type { DropdownOption } from './Dropdown';
import { PROVIDER_LABELS, ProviderIcon } from './icons';

/** The agent CLI's display name, e.g. "Claude Code". Unknown providers show their id. */
export function agentName(providerId: string): string {
  return PROVIDER_LABELS[providerId] ?? providerId;
}

/**
 * A session as a picker option (PM-331): the agent's mark before the name, and the agent in the
 * secondary line so a renamed session still says what it runs. Search matches the agent name too,
 * because the Dropdown searches the secondary line. The agent is not repeated when the session is
 * simply named after it.
 */
export function sessionOption(
  session: { id: number; name: string; providerId: string },
  detail: string,
  hint?: string,
): DropdownOption<number> {
  const agent = agentName(session.providerId);
  const named = session.name.trim().toLowerCase() === agent.toLowerCase();
  return {
    value: session.id,
    label: session.name,
    icon: <ProviderIcon id={session.providerId} size={14} />,
    sub: named ? detail : `${agent} · ${detail}`,
    hint,
  };
}
