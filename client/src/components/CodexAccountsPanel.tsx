import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodexAccount, CodexAccountsState } from '../../../shared/types';
import { api } from '../api';
import { ProviderIcon } from './icons';
import { UsageLimits } from './UsageLimits';

/**
 * Settings → Codex accounts (PM-164): manage saved Codex auth.json profiles, switch the active
 * account for new sessions/runs, save the current ~/.codex login, or automatically rotate to the
 * next non-exhausted account when a session or run hits its usage limit.
 */
export function CodexAccountsPanel({ onError }: { onError: (message: string) => void }) {
  const [state, setState] = useState<CodexAccountsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [importName, setImportName] = useState('');
  const [importJson, setImportJson] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(() => {
    api.getCodexAccounts().then(
      (s) => {
        setState(s);
        setNow(Date.now());
      },
      (e: Error) => onError(e.message),
    );
  }, [onError]);

  useEffect(() => {
    load();
  }, [load]);

  const act = useCallback(
    async (fn: () => Promise<CodexAccountsState>) => {
      setBusy(true);
      try {
        const next = await fn();
        setState(next);
        setNow(Date.now());
        onError('');
        return true;
      } catch (e) {
        onError((e as Error).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onError],
  );

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setImportJson(text);
      if (!importName.trim()) {
        const base = file.name.replace(/\.json$/i, '').trim();
        if (base && base.toLowerCase() !== 'auth') setImportName(base);
      }
    } catch {
      onError('Could not read the selected JSON file.');
    } finally {
      e.target.value = '';
    }
  }

  async function submitImport(e: React.FormEvent) {
    e.preventDefault();
    if (!importName.trim() || !importJson.trim()) return;
    const ok = await act(() => api.importCodexAccount(importName.trim(), importJson.trim()));
    if (ok) {
      setImportName('');
      setImportJson('');
      setShowAdd(false);
    }
  }

  async function submitRename(account: CodexAccount) {
    const trimmed = renameDraft.trim();
    if (!trimmed || trimmed === account.name) {
      setRenamingId(null);
      return;
    }
    const ok = await act(() => api.renameCodexAccount(account.id, trimmed));
    if (ok) setRenamingId(null);
  }

  const activeLabel =
    state === null
      ? 'loading…'
      : state.activeProfileId === null
        ? 'Default CLI account'
        : (state.accounts.find((a) => a.id === state.activeProfileId)?.name ??
          'Default CLI account');

  return (
    <section className="panel" aria-label="Codex accounts">
      <div className="panel-header">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <ProviderIcon id="codex" size={15} />
          <h2>Codex accounts</h2>
        </span>
        <span className="meta">active: {activeLabel}</span>
      </div>
      <p className="faint" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
        Switch between your default Codex CLI login (<code>~/.codex/auth.json</code>) and saved{' '}
        <code>auth.json</code> profiles, or automatically rotate to another account with remaining
        quota when a session or run hits a usage limit.
      </p>

      {state === null ? (
        <div className="skeleton" style={{ height: 100 }} />
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              marginBottom: 12,
            }}
          >
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={state.autoSwitch}
                disabled={busy}
                onChange={() => act(() => api.setCodexAutoSwitch(!state.autoSwitch))}
              />
              <span>Automatically switch accounts when hitting usage limits</span>
            </label>
            <span className="actions" style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
              {state.defaultAccount?.available && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => act(() => api.saveCurrentCodexAccount())}
                  title="Copy ~/.codex/auth.json into your saved Codex accounts pool"
                >
                  Save current CLI login
                </button>
              )}
              <button
                type="button"
                className={showAdd ? 'btn btn-sm' : 'btn btn-primary btn-sm'}
                disabled={busy}
                onClick={() => setShowAdd((v) => !v)}
              >
                {showAdd ? 'Cancel' : 'Import auth.json'}
              </button>
            </span>
          </div>

          {showAdd && (
            <form
              onSubmit={submitImport}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                padding: 12,
                marginBottom: 12,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--bg-subtle, rgba(255,255,255,0.02))',
              }}
            >
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  type="text"
                  className="input"
                  placeholder="Account name (e.g. Work Pro, Backup Plus)"
                  aria-label="Account name"
                  value={importName}
                  onChange={(e) => setImportName(e.target.value)}
                  style={{ flex: '1 1 220px' }}
                  required
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                  aria-label="Choose auth.json file"
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Choose auth.json file…
                </button>
              </div>
              <textarea
                className="input mono"
                rows={4}
                placeholder='Paste Codex auth.json contents ({"tokens": ...} or {"OPENAI_API_KEY": ...})'
                aria-label="Codex auth.json contents"
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                style={{ fontSize: 12, resize: 'vertical' }}
                required
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={busy || !importName.trim() || !importJson.trim()}
                >
                  Save account
                </button>
              </div>
            </form>
          )}

          <ul className="list">
            <li
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <span
                className={`status-dot${state.activeProfileId === null ? ' green' : ''}`}
                role="img"
                aria-label={state.activeProfileId === null ? 'Active account' : 'Inactive account'}
              />
              <span style={{ flex: 1, minWidth: 180 }}>
                <b>Default Codex account</b>{' '}
                <span className="faint" style={{ fontSize: 12.5 }}>
                  (<code>~/.codex/auth.json</code>)
                </span>
                {state.defaultAccount?.email && (
                  <span className="faint" style={{ fontSize: 12.5 }}>
                    {' '}
                    · {state.defaultAccount.email}
                  </span>
                )}
                {state.defaultAccount?.plan && (
                  <>
                    {' '}
                    <span className="badge">{state.defaultAccount.plan}</span>
                  </>
                )}
                {state.defaultAccount && !state.defaultAccount.available && (
                  <span className="faint" style={{ fontSize: 12.5 }}>
                    {' '}
                    · not signed in
                  </span>
                )}
                {state.defaultAccount?.limits && (
                  <UsageLimits limits={state.defaultAccount.limits} now={now} />
                )}
              </span>
              {state.activeProfileId === null ? (
                <span className="badge badge-done">active</span>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => act(() => api.setActiveCodexAccount(null))}
                >
                  Use default
                </button>
              )}
            </li>

            {state.accounts.map((acc) => {
              const isActive = state.activeProfileId === acc.id;
              const isRenaming = renamingId === acc.id;
              return (
                <li
                  key={acc.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <span
                    className={`status-dot${isActive ? ' green' : ''}`}
                    role="img"
                    aria-label={isActive ? 'Active account' : 'Saved account'}
                  />
                  <span style={{ flex: 1, minWidth: 180 }}>
                    {isRenaming ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type="text"
                          className="input"
                          value={renameDraft}
                          aria-label={`Rename ${acc.name}`}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void submitRename(acc);
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          style={{ height: 26, padding: '2px 8px', fontSize: 13 }}
                        />
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={busy}
                          onClick={() => submitRename(acc)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setRenamingId(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <>
                        <b>{acc.name}</b>
                        {acc.email && (
                          <span className="faint" style={{ fontSize: 12.5 }}>
                            {' '}
                            · {acc.email}
                          </span>
                        )}
                        {acc.plan && (
                          <>
                            {' '}
                            <span className="badge">{acc.plan}</span>
                          </>
                        )}
                      </>
                    )}
                    {acc.limits && <UsageLimits limits={acc.limits} now={now} />}
                  </span>
                  <span className="actions" style={{ display: 'inline-flex', gap: 6 }}>
                    {isActive ? (
                      <span className="badge badge-done">active</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => act(() => api.setActiveCodexAccount(acc.id))}
                      >
                        Switch to account
                      </button>
                    )}
                    {!isRenaming && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => {
                          setRenamingId(acc.id);
                          setRenameDraft(acc.name);
                        }}
                      >
                        Rename
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => act(() => api.removeCodexAccount(acc.id))}
                      aria-label={`Remove ${acc.name}`}
                    >
                      Remove
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
