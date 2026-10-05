// The agent last picked for a new session (e.g. "claude"), remembered per browser so both
// new-session forms (a project's Agents tab and the workspace toolbar) start from it.
const KEY = 'pm.newSession.agent';

// Retired providers map to their replacement, so an old pick never preselects them.
const REPLACED_BY: Record<string, string> = { gemini: 'antigravity' };

export function readLastAgent(fallback: string): string {
  try {
    const stored = localStorage.getItem(KEY);
    return (stored && (REPLACED_BY[stored] ?? stored)) || fallback;
  } catch {
    return fallback;
  }
}

export function saveLastAgent(providerId: string): void {
  try {
    localStorage.setItem(KEY, providerId);
  } catch {
    // A convenience only.
  }
}
