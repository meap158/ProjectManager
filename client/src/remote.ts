// LAN access (server/lan.ts) serves this same app to signed-in phones and tablets. The page can
// tell where it was opened from by its own address: this computer always uses a loopback name.

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** True when this page was opened from another device over LAN access, not on this computer. */
export function isRemoteClient(hostname = location.hostname): boolean {
  return !LOOPBACK.has(hostname);
}

const RELOAD_KEY = 'pm-signed-out-reload';

/**
 * The app's API never answers 401 itself: only the LAN gate does, when this device has been
 * signed out (Settings → LAN access on the computer). Reloading the page lets the gate show its
 * sign-in form, which returns here afterwards (AdRelay's "stale session" screen, done by the gate).
 * At most once every 10 seconds, so a misbehaving gate can never cause a reload loop.
 */
export function handleSignedOut(): void {
  if (!isRemoteClient()) return;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Storage refused (private mode): reload anyway; the gate answers with its own page.
  }
  location.reload();
}
