import { useEffect, useState } from 'react';
import type { LanStatus } from '../../../shared/types';
import { api } from '../api';
import { formatRelative } from '../format';

/**
 * Settings → LAN access (opt-in). Other devices open the address below and type the short code,
 * like signing in to GitHub on a TV: the code works once, expires after 10 minutes, and is retired
 * after 5 wrong tries. Each signed-in device is listed and can be signed out.
 */
export function LanAccessPanel({ onError }: { onError: (message: string) => void }) {
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = () =>
      api.lanStatus().then(
        (s) => active && setStatus(s),
        (e: Error) => active && onError(e.message),
      );
    void load();
    // The code is single use and expires: keep what's shown current.
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [onError]);

  async function act(fn: () => Promise<LanStatus>) {
    setBusy(true);
    try {
      setStatus(await fn());
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      onError('Could not copy; select the address and copy it by hand.');
    }
  }

  return (
    <section className="panel" aria-label="LAN access">
      <div className="panel-header">
        <h2>LAN access</h2>
        <span className="meta">
          {status === null
            ? 'checking…'
            : status.running
              ? `on · port ${status.port}`
              : status.enabled
                ? 'enabled, not listening'
                : 'off'}
        </span>
      </div>
      <p className="faint" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
        Use ProjectManager from your phone or another computer on the same network. Open the address
        on that device and type the code shown here. Signed-in devices can read your tracked folders
        and drive your agents. Windows may ask to allow Node.js the first time: allow it on Private
        networks only.
      </p>
      {status === null ? (
        <div className="skeleton" style={{ height: 60 }} />
      ) : (
        <>
          <div className="lan-actions">
            <button
              type="button"
              className={status.enabled ? 'btn' : 'btn btn-primary'}
              disabled={busy}
              onClick={() => act(() => api.setLan(!status.enabled))}
            >
              {status.enabled ? 'Turn off LAN access' : 'Turn on LAN access'}
            </button>
          </div>
          {status.error && <div className="error-banner">{status.error}</div>}
          {status.running && (
            <div className="lan-signin">
              <div>
                <div className="lan-label">1. Open on the device</div>
                {status.urls.length === 0 ? (
                  <p className="faint" style={{ margin: 0 }}>
                    No local network address found: connect this computer to a network.
                  </p>
                ) : (
                  <ul className="list lan-links">
                    {status.urls.map((url) => (
                      <li key={url}>
                        <code className="truncate">{url}</code>
                        <button type="button" className="btn btn-sm" onClick={() => copy(url)}>
                          {copied === url ? 'Copied' : 'Copy'}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="lan-label">2. Type this code</div>
                <div className="lan-code" aria-label={`Sign-in code ${status.code ?? ''}`}>
                  {status.code}
                </div>
                <div className="faint" style={{ fontSize: 12 }}>
                  One device, once · new code{' '}
                  {status.codeExpiresAt ? formatRelative(status.codeExpiresAt) : ''}{' '}
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    onClick={() => act(() => api.lanNewCode())}
                  >
                    New code
                  </button>
                </div>
              </div>
            </div>
          )}
          {status.devices.length > 0 && (
            <>
              <div className="lan-label" style={{ marginTop: 14 }}>
                Signed-in devices
              </div>
              <ul className="list lan-devices">
                {status.devices.map((d) => (
                  <li key={d.id}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <b>{d.label}</b>{' '}
                      <span className="faint" style={{ fontSize: 12.5 }}>
                        {d.address} · signed in {formatRelative(d.signedInAt)} · last seen{' '}
                        {formatRelative(d.lastSeenAt)}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => act(() => api.lanSignOut(d.id))}
                    >
                      Sign out
                    </button>
                  </li>
                ))}
              </ul>
              {status.devices.length > 1 && (
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() => act(() => api.lanSignOut())}
                >
                  Sign out all devices
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
