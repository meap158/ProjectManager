import { RemoteAccessGuide } from './RemoteAccessGuide';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { RemoteConfig, RemoteStatus } from '../../../shared/types';
import { api } from '../api';
import { formatRelative } from '../format';
import { isRemoteClient } from '../remote';

/**
 * Settings → Remote access (opt-in). Reaches this app from anywhere through a Cloudflare Tunnel
 * you run yourself. Three checks stand in front of it: Cloudflare Access (your MFA policy), an
 * email list kept here, and an authenticator code. Everything on this panel, including the
 * authenticator secret, is answered on this computer only.
 */
export function RemoteAccessPanel({ onError }: { onError: (message: string) => void }) {
  if (isRemoteClient()) {
    return (
      <section className="panel" aria-label="Remote access">
        <div className="panel-header">
          <h2>Remote access</h2>
          <span className="meta">managed on the computer</span>
        </div>
        <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
          Cloudflare details, the authenticator secret and signed-in sessions are only shown in
          Settings on the computer running ProjectManager.
        </p>
      </section>
    );
  }
  return <LocalRemoteAccessPanel onError={onError} />;
}

function LocalRemoteAccessPanel({ onError }: { onError: (message: string) => void }) {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [form, setForm] = useState<{ team: string; aud: string; hostname: string; emails: string }>(
    { team: '', aud: '', hostname: '', emails: '' },
  );
  const [code, setCode] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api.remoteStatus().then(
      (s) => {
        if (!active) return;
        setStatus(s);
        setForm({ ...s.config, emails: s.config.emails.join('\n') });
      },
      (e: Error) => active && onError(e.message),
    );
    return () => {
      active = false;
    };
  }, [onError]);

  const otpauth = status?.pendingTotp?.otpauth;
  useEffect(() => {
    let active = true;
    if (!otpauth) return;
    QRCode.toDataURL(otpauth, { width: 200, margin: 3, errorCorrectionLevel: 'M' }).then(
      (image) => active && setQr(image),
      () => active && onError('Could not draw the QR code. Type the secret into your app instead.'),
    );
    return () => {
      active = false;
      setQr(null);
    };
  }, [otpauth, onError]);

  async function act(fn: () => Promise<RemoteStatus>) {
    setBusy(true);
    try {
      setStatus(await fn());
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const config = (): RemoteConfig => ({
    team: form.team,
    aud: form.aud,
    hostname: form.hostname,
    emails: form.emails.split(/[\s,;]+/).filter(Boolean),
  });

  return (
    <section className="panel" aria-label="Remote access">
      <div className="panel-header">
        <h2 className="remote-guide-heading">
          Remote access
          <RemoteAccessGuide port={status?.port ?? null} />
        </h2>
        <span className="meta">
          {status === null
            ? 'checking…'
            : status.running
              ? `on · tunnel to 127.0.0.1:${status.port}`
              : status.enabled
                ? 'enabled, not listening'
                : 'off'}
        </span>
      </div>
      <p className="faint remote-intro">
        Use ProjectManager from anywhere through a Cloudflare Tunnel you run yourself. A signed-in
        person can read your tracked folders and drive your agents, so three checks stand in front
        of it: Cloudflare Access with your MFA policy, the email list below, and an authenticator
        code. Setup steps are in docs/REMOTE-ACCESS.md.
      </p>
      {status === null ? (
        <div className="skeleton" style={{ height: 60 }} />
      ) : (
        <div className="remote-steps">
          <section className="remote-step" aria-labelledby="remote-step-1">
            <h3 id="remote-step-1" className="remote-step-title">
              <span className="remote-step-num" aria-hidden="true">
                1
              </span>
              Cloudflare details
            </h3>
            <div className="remote-fields">
              <label className="remote-field">
                <span>Team name</span>
                <input
                  className="input"
                  value={form.team}
                  placeholder="myteam (from myteam.cloudflareaccess.com)"
                  onChange={(e) => setForm({ ...form, team: e.target.value })}
                />
              </label>
              <label className="remote-field">
                <span>Public hostname</span>
                <input
                  className="input"
                  value={form.hostname}
                  placeholder="pm.example.com"
                  onChange={(e) => setForm({ ...form, hostname: e.target.value })}
                />
              </label>
              <label className="remote-field remote-field-wide">
                <span>Application AUD tag</span>
                <input
                  className="input mono"
                  value={form.aud}
                  placeholder="64 hex characters"
                  spellCheck={false}
                  onChange={(e) => setForm({ ...form, aud: e.target.value })}
                />
              </label>
              <label className="remote-field remote-field-wide">
                <span>Allowed emails (one per line)</span>
                <textarea
                  className="textarea"
                  rows={3}
                  value={form.emails}
                  onChange={(e) => setForm({ ...form, emails: e.target.value })}
                />
              </label>
            </div>
            <div className="lan-actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => act(() => api.remoteConfigure(config()))}
              >
                Save details
              </button>
            </div>
          </section>

          <section className="remote-step" aria-labelledby="remote-step-2">
            <h3 id="remote-step-2" className="remote-step-title">
              <span className="remote-step-num" aria-hidden="true">
                2
              </span>
              Authenticator app
              <span className={`badge${status.totpConfirmed ? ' badge-done' : ''}`}>
                {status.totpConfirmed ? 'set up' : 'not set up'}
              </span>
            </h3>
            {status.pendingTotp ? (
              <div className="remote-totp">
                <div className="lan-qr">
                  {qr ? (
                    <img src={qr} width="200" height="200" alt="Scan with your authenticator app" />
                  ) : (
                    <div className="skeleton" style={{ width: 200, height: 200 }} />
                  )}
                  <span className="faint">
                    Or type this secret into the app: <code>{status.pendingTotp.secret}</code>
                  </span>
                </div>
                <div className="remote-code">
                  <label className="remote-field">
                    <span>Code from the app</span>
                    <input
                      className="input mono"
                      value={code}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={7}
                      onChange={(e) => setCode(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || code.replace(/\s/g, '').length !== 6}
                    onClick={() =>
                      act(async () => {
                        const next = await api.remoteConfirmTotp(code);
                        setCode('');
                        return next;
                      })
                    }
                  >
                    Confirm code
                  </button>
                </div>
              </div>
            ) : (
              <div className="remote-row">
                <p className="faint remote-note">
                  {status.totpConfirmed
                    ? 'An authenticator is set up. Setting up again replaces it and signs everyone out.'
                    : 'Not set up yet. Remote access cannot be switched on without it.'}
                </p>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => act(() => api.remoteBeginTotp())}
                >
                  {status.totpConfirmed ? 'Set up again' : 'Set up authenticator'}
                </button>
              </div>
            )}
          </section>

          <section className="remote-step" aria-labelledby="remote-step-3">
            <h3 id="remote-step-3" className="remote-step-title">
              <span className="remote-step-num" aria-hidden="true">
                3
              </span>
              Switch on
            </h3>
            {status.missing.length > 0 && !status.enabled && (
              <p className="faint remote-note">Still needed: {status.missing.join(', ')}.</p>
            )}
            {status.error && <div className="error-banner">{status.error}</div>}
            <div className="lan-actions">
              <button
                type="button"
                className={status.enabled ? 'btn' : 'btn btn-primary'}
                disabled={busy || (!status.enabled && status.missing.length > 0)}
                onClick={() => act(() => api.setRemote(!status.enabled))}
              >
                {status.enabled ? 'Turn off remote access' : 'Turn on remote access'}
              </button>
            </div>
            {status.running && (
              <p className="faint remote-note">
                Point your tunnel at{' '}
                <code>http://127.0.0.1:{window.location.port || status.port}</code> (this app&apos;s
                own port) or at <code>http://127.0.0.1:{status.port}</code>, and open{' '}
                <code>https://{status.config.hostname}</code>. Either way the public address only
                opens after Cloudflare Access and your authenticator code.
              </p>
            )}
          </section>

          {status.sessions.length > 0 && (
            <section className="remote-step" aria-labelledby="remote-step-sessions">
              <h3 id="remote-step-sessions" className="remote-step-title">
                Signed-in sessions
              </h3>
              <ul className="list lan-devices">
                {status.sessions.map((s) => (
                  <li key={s.id}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <b>{s.email}</b>{' '}
                      <span className="faint" style={{ fontSize: 12.5 }}>
                        signed in {formatRelative(s.signedInAt)} · last seen{' '}
                        {formatRelative(s.lastSeenAt)}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => act(() => api.remoteSignOut(s.id))}
                    >
                      Sign out
                    </button>
                  </li>
                ))}
              </ul>
              {status.sessions.length > 1 && (
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() => act(() => api.remoteSignOut())}
                >
                  Sign out all sessions
                </button>
              )}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
