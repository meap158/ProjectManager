import { useEffect, useRef, useState } from 'react';
import type { AntigravityAccountsState } from '../../../shared/antigravityAccounts';
import { api } from '../api';

export function AntigravityAccountsPanel() {
  const [state, setState] = useState<AntigravityAccountsState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let mounted = true;
    api.getAntigravityAccounts().then(
      (s) => {
        if (mounted) setState(s);
      },
      () => {
        if (mounted) setError('Unable to read Antigravity accounts.');
      },
    );
    return () => {
      mounted = false;
    };
  }, []);
  async function act(fn: () => Promise<AntigravityAccountsState>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      setState(await fn());
      setChosen(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Antigravity accounts">
      <h3>Antigravity accounts</h3>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {!state && !error && <p role="status">Loading accounts…</p>}
      {state && !state.available && (
        <p>Native Antigravity account management is unavailable on this platform.</p>
      )}
      {state?.available && (
        <>
          <p className="faint">
            Switching changes the login for new Antigravity launches. Existing sessions keep their
            login until restarted.
          </p>
          <p className="faint">
            Saved logins are encrypted locally. If usage is unavailable because a login expired,
            sign in with Antigravity and save that login again.
          </p>
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void act(api.refreshAntigravityAccounts)}
          >
            Refresh usage
          </button>{' '}
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() => void act(api.saveAntigravityAccount)}
          >
            Save current CLI login
          </button>{' '}
          <button className="btn btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
            Import credential file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            aria-label="Antigravity credential file"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              if (file.size > 65536) {
                setError('Credential file is too large.');
                return;
              }
              const raw = await file.text();
              await act(() => api.importAntigravityAccount(raw));
            }}
          />
          {!state.accounts.length && (
            <p>
              No saved accounts. Sign in with Antigravity, then save the current CLI login, or
              import a credential file.
            </p>
          )}
          <ul className="antigravity-account-list">
            {state.accounts.map((a) => (
              <li key={a.id}>
                <div>
                  <strong>{a.name}</strong> {a.plan}{' '}
                  {a.active && <span className="badge badge-live">active</span>}
                </div>
                <p className="faint">
                  {a.usage.updatedAt
                    ? `Usage checked ${new Date(a.usage.updatedAt).toLocaleString()}`
                    : 'Usage not refreshed'}
                </p>
                <p>
                  5-hour: {a.usage.fiveHour === null ? 'Unavailable' : `${a.usage.fiveHour}% used`}{' '}
                  · Weekly: {a.usage.weekly === null ? 'Unavailable' : `${a.usage.weekly}% used`}
                </p>
                {!a.active && (
                  <button className="btn btn-sm" disabled={busy} onClick={() => setChosen(a.id)}>
                    Switch to account
                  </button>
                )}
                {chosen === a.id && (
                  <div>
                    <p>
                      Use {a.name} for new launches? Running sessions will keep their current login.
                    </p>
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={busy}
                      onClick={() => void act(() => api.switchAntigravityAccount(a.id))}
                    >
                      Confirm switch
                    </button>{' '}
                    <button className="btn btn-sm" disabled={busy} onClick={() => setChosen(null)}>
                      Cancel
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
