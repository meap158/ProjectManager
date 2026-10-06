import { useEffect, useState } from 'react';
import type { LanStatus } from '../../../shared/types';
import { api } from '../api';

/**
 * Settings → LAN access (opt-in). A separate listener on the local network that only serves
 * devices holding the access key: each link below signs a device in once (secure cookie).
 * Anyone with a link can read your tracked folders and drive agents, so share it like a password.
 */
export function LanAccessPanel({ onError }: { onError: (message: string) => void }) {
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.lanStatus().then(
      (s) => active && setStatus(s),
      (e: Error) => active && onError(e.message),
    );
    return () => {
      active = false;
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
      onError('Could not copy; select the link and copy it by hand.');
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
        Open ProjectManager from other devices on your network (phone, laptop). Each device signs in
        once with the link below. Anyone with the link can read your tracked folders and drive your
        agents, so share it like a password; <b>New key</b> signs every device out. Windows may ask
        to allow Node.js on private networks the first time.
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
            {status.enabled && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                title="Make a new access key: every signed-in device must open the new link"
                onClick={() => act(() => api.regenerateLanKey())}
              >
                New key
              </button>
            )}
          </div>
          {status.error && <div className="error-banner">{status.error}</div>}
          {status.running && status.urls.length === 0 && (
            <p className="faint" style={{ margin: '10px 0 0' }}>
              No local network address found: connect this computer to a network.
            </p>
          )}
          {status.urls.length > 0 && (
            <ul className="list lan-links">
              {status.urls.map((url) => (
                <li key={url}>
                  <code className="truncate" title={url}>
                    {url}
                  </code>
                  <button type="button" className="btn btn-sm" onClick={() => copy(url)}>
                    {copied === url ? 'Copied' : 'Copy link'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
