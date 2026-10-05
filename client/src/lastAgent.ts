// The agent last picked for a new session (e.g. "claude"), remembered per browser so both
// new-session forms (a project's Agents tab and the workspace toolbar) start from it.
const KEY = 'pm.newSession.agent';

export function readLastAgent(fallback: string): string {
  try {
    return localStorage.getItem(KEY) || fallback;
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
