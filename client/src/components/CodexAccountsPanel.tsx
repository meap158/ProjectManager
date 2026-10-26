import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodexAccount, CodexAccountsState } from '../../../shared/types';
import { api } from '../api';
import { formatDate, formatRelative } from '../format';
import { InfoIcon, ProviderIcon } from './icons';
import './project-agents.css';
import { UsageLimits } from './UsageLimits';
import { serialPoll } from '../lib/serialPoll';
import { useViewPreference } from '../useViewPreference';

export function AccountActionIcon({
  action,
}: {
  action: 'switch' | 'rename' | 'remove' | 'refresh' | 'save' | 'import' | 'cancel';
}) {
  const paths = {
    switch: 'M3 8h10M9 4l4 4-4 4',
    rename: 'M3 11l-1 3 3-1 8-8-2-2-8 8z',
    remove: 'M3 4h10M6 4V2h4v2M5 4v10h6V4',
    refresh: 'M13 6A5 5 0 1 0 13 10M13 2v4H9',
    save: 'M2 2h10l2 2v10H2V2zM5 2v4h6V2M5 14V9h6v5',
    import: 'M8 2v8M5 7l3 3 3-3M2 10v4h12v-4',
    cancel: 'M4 4l8 8M12 4l-8 8',
  };
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[action]} />
    </svg>
  );
}

export type AccountProviderId = 'codex' | 'claude';

/**
 * Settings → Agent CLIs → Accounts (PM-164, PM-168, PM-169, PM-173): manage saved CLI credential
 * profiles (Codex `~/.codex/auth.json` and Claude Code `~/.claude/.credentials.json`), switch the
 * active account, save the current login, or automatically rotate to the next non-exhausted
 * account when a Codex CLI hits its usage limit. The account selected here is the login for
 * every session, run and orchestrator chat that uses that CLI.
 */
export function CodexAccountsPanel({
  providerId = 'codex',
  onError,
}: {
  providerId?: AccountProviderId;
  onError: (message: string) => void;
}) {
  const helpRef = useRef<HTMLDialogElement>(null);
  const switchHelpRef = useRef<HTMLDialogElement>(null);
  const isClaude = providerId === 'claude';
  const cliTitle = isClaude ? 'Claude' : 'Codex';
  const credFile = isClaude ? '~/.claude/.credentials.json' : '~/.codex/auth.json';
  const importFileLabel = isClaude ? '.credentials.json' : 'auth.json';
  const [state, setState] = useState<CodexAccountsState | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshingUsage, setRefreshingUsage] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [order, setOrder] = useViewPreference<string[]>(
    `pm.accounts.order.${providerId}`,
    [],
    (v): v is string[] => Array.isArray(v) && v.every((id) => typeof id === 'string'),
  );
  const orderedAccounts = [...(state?.accounts ?? [])].sort((a, b) => {
    const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
    return rank(a.id) - rank(b.id);
  });
  const moveAccount = (id: string, delta: number) => {
    const ids = orderedAccounts.map((a) => a.id);
    const from = ids.indexOf(id),
      to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    setOrder(ids);
  };
  const [showAdd, setShowAdd] = useState(false);
  const [importName, setImportName] = useState('');
  const [importJson, setImportJson] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const revision = useRef(0);
  const acting = useRef(false);
  const invalidateReads = useCallback(() => {
    ++revision.current;
  }, []);

  const load = useCallback(async () => {
    if (acting.current) return;
    const started = ++revision.current;
    // Codex: opening the panel also re-reads missing or old usage in the background (PM-173).
    const fetchState = isClaude ? api.getClaudeAccounts : api.getCodexAccountsRefreshing;
    await fetchState().then(
      (s) => {
        if (started !== revision.current) return;
        setState(s);
        setNow(Date.now());
      },
      (e: Error) => {
        if (started === revision.current) onError(e.message);
      },
    );
  }, [isClaude, onError]);

  useEffect(() => {
    const stop = serialPoll(load, 60_000, { pauseWhenHidden: true });
    return () => {
      invalidateReads();
      stop();
    };
  }, [load, invalidateReads]);

  // While the server re-reads usage in the background, follow it until it is done.
  const backgroundRefresh = !!state?.usageRefreshing;
  useEffect(() => {
    if (!backgroundRefresh || isClaude) return;
    let active = true;
    const stop = serialPoll(
      async () => {
        if (acting.current) return;
        const started = ++revision.current;
        await api.getCodexAccounts().then(
          (s) => {
            if (!active || started !== revision.current) return;
            setState(s);
            setNow(Date.now());
          },
          () => {},
        );
      },
      2500,
      { pauseWhenHidden: true },
    );
    return () => {
      active = false;
      stop();
    };
  }, [backgroundRefresh, isClaude]);
  const loadingUsage = refreshingUsage || backgroundRefresh;

  // Auto-switch breaks a tie by this order, so the server keeps it (Codex only: Claude accounts
  // never switch automatically). Once saved, the browser's copy is dropped so every device shows
  // the server's order; this also carries over an order saved in this browser earlier.
  const shownOrder = JSON.stringify(orderedAccounts.map((a) => a.id));
  const savedOrder = JSON.stringify((state?.accounts ?? []).map((a) => a.id));
  useEffect(() => {
    if (isClaude || !order.length || shownOrder === savedOrder) return;
    invalidateReads();
    api.setCodexAccountOrder(JSON.parse(shownOrder) as string[]).then(
      (next) => {
        invalidateReads();
        setState(next);
        setOrder([]);
      },
      (e: Error) => onError(e.message),
    );
  }, [isClaude, order.length, shownOrder, savedOrder, invalidateReads, onError, setOrder]);

  const act = useCallback(
    async (fn: () => Promise<CodexAccountsState>) => {
      if (acting.current) return false;
      acting.current = true;
      ++revision.current;
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
        ++revision.current;
        acting.current = false;
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
        const base = file.name
          .replace(/^\.+/, '')
          .replace(/\.json$/i, '')
          .trim();
        if (base && base.toLowerCase() !== 'auth' && base.toLowerCase() !== 'credentials') {
          setImportName(base);
        }
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
    const ok = await act(() =>
      isClaude
        ? api.importClaudeAccount(importName.trim(), importJson.trim())
        : api.importCodexAccount(importName.trim(), importJson.trim()),
    );
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
    const ok = await act(() =>
      isClaude
        ? api.renameClaudeAccount(account.id, trimmed)
        : api.renameCodexAccount(account.id, trimmed),
    );
    if (ok) setRenamingId(null);
  }

  // Codex CLIs always run on ~/.codex/auth.json: switching copies a saved login there (PM-243),
  // so the default row is the login in use, and the saved profile it matches is marked too.
  const defaultInUse = !isClaude || state?.activeProfileId === null;
  const activeLabel =
    state === null
      ? 'loading…'
      : state.activeProfileId === null
        ? 'Default CLI account'
        : (state.accounts.find((a) => a.id === state.activeProfileId)?.name ??
          'Default CLI account');

  return (
    <div className="codex-accounts-panel" role="region" aria-label={`${cliTitle} accounts`}>
      <div
        className="panel-header"
        style={{ marginBottom: 6, paddingBottom: 0, borderBottom: 'none' }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <ProviderIcon id={providerId} size={14} />
          <strong style={{ fontSize: 13 }}>{cliTitle} accounts</strong>
        </span>
        <span className="meta">active: {activeLabel}</span>
      </div>
      <p
        className="faint"
        style={{
          margin: '0 0 12px',
          fontSize: 12.5,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        The selected account is used by every {cliTitle} session, run and orchestrator chat.
        <button
          type="button"
          className="icon-btn info-btn"
          title={`How to add a ${cliTitle} account`}
          aria-label={`How to add a ${cliTitle} account`}
          aria-haspopup="dialog"
          onClick={() => helpRef.current?.showModal()}
        >
          <InfoIcon size={14} />
        </button>
      </p>
      <dialog
        ref={helpRef}
        className="confirm-dialog sessions-info-dialog"
        aria-label={`How to add a ${cliTitle} account`}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="dialog-body">
          <h2>Add a {cliTitle} account</h2>
          <ol style={{ paddingLeft: 18, margin: '0 0 8px' }}>
            <li>
              In a terminal, run <code>{isClaude ? 'claude' : 'codex login'}</code>
              {isClaude && ' and type /login'} and sign in.
            </li>
            <li>
              Back here, click <strong>Save current CLI login</strong>.
            </li>
            <li>Repeat for each account, then use Switch to account.</li>
          </ol>
          <p style={{ margin: 0 }}>
            Default login: <code>{credFile}</code>. Saved profiles are{' '}
            <code>{importFileLabel}</code> copies.
            {!isClaude && ' Never run codex logout: it revokes the token on OpenAI’s server.'}
            {!isClaude && ' Switching keeps each session’s conversation going.'}
          </p>
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn" onClick={() => helpRef.current?.close()}>
            Close
          </button>
        </div>
      </dialog>

      <dialog
        ref={switchHelpRef}
        className="confirm-dialog sessions-info-dialog"
        aria-label="How auto-switch works"
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="dialog-body">
          <h2>How auto-switch works</h2>
          <ul style={{ paddingLeft: 18, margin: '0 0 8px' }}>
            <li>
              Fresh usage must confirm that the current account has reached a limit. It waits until
              all affected sessions are idle with empty prompts, no pending input, and no Codex run
              still working. A turn still finishing at 100% is allowed to finish.
            </li>
            <li>
              It picks the account with the most 5-hour quota left. A tie goes to more weekly quota
              left, then to the account higher in the list (Reorder accounts).
            </li>
            <li>
              It skips accounts with Auto-switch off, any limit at 100%, or usage it couldn&apos;t
              check in the last minute. Reset-due readings must be checked again. An account it left
              becomes eligible again only after fresh usage confirms quota has returned.
            </li>
            <li>If no account qualifies, it stays on the current one and waits for the reset.</li>
            <li>
              Sessions resume their exact conversations. Only sessions blocked by a limit receive
              Continue; completed idle work is not prompted again. Ended sessions stay ended. A
              blocked run waits for active work to finish before retrying.
            </li>
          </ul>
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn" onClick={() => switchHelpRef.current?.close()}>
            Close
          </button>
        </div>
      </dialog>

      {state === null ? (
        <div className="skeleton" style={{ height: 100 }} />
      ) : (
        <>
          <div className="codex-accounts-toolbar">
            {!isClaude && (
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
            )}
            {!isClaude && (
              <button
                type="button"
                className="icon-btn info-btn"
                title="When usage confirms exhaustion, wait for active work to finish. Prefer most 5-hour quota, then weekly, then saved order. Click for details."
                aria-label="How auto-switch works"
                aria-haspopup="dialog"
                onClick={() => switchHelpRef.current?.showModal()}
              >
                <InfoIcon size={14} />
              </button>
            )}
            <span className="actions codex-accounts-toolbar-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || refreshingUsage}
                aria-label={refreshingUsage ? 'Refreshing usage…' : 'Refresh usage'}
                title="Refresh usage for all accounts"
                onClick={async () => {
                  setRefreshingUsage(true);
                  try {
                    await act(isClaude ? api.getClaudeAccounts : api.refreshCodexAccountsUsage);
                  } finally {
                    setRefreshingUsage(false);
                  }
                }}
              >
                <AccountActionIcon action="refresh" />
                <span className="account-action-label">
                  {refreshingUsage ? 'Refreshing usage…' : 'Refresh usage'}
                </span>
              </button>
              {state.defaultAccount?.available && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() =>
                    act(() =>
                      isClaude ? api.saveCurrentClaudeAccount() : api.saveCurrentCodexAccount(),
                    )
                  }
                  aria-label="Save current CLI login"
                  title={`Save ${credFile} into your ${cliTitle} accounts pool`}
                >
                  <AccountActionIcon action="save" />
                  <span className="account-action-label">Save current CLI login</span>
                </button>
              )}
              <button
                type="button"
                className={showAdd ? 'btn btn-sm' : 'btn btn-primary btn-sm'}
                disabled={busy}
                aria-label={showAdd ? 'Cancel' : `Import ${importFileLabel}`}
                title={showAdd ? 'Cancel import' : `Import ${importFileLabel}`}
                onClick={() => setShowAdd((v) => !v)}
              >
                <AccountActionIcon action={showAdd ? 'cancel' : 'import'} />
                <span className="account-action-label">
                  {showAdd ? 'Cancel' : `Import ${importFileLabel}`}
                </span>
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
                  aria-label={`Choose ${importFileLabel} file`}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Choose {importFileLabel} file…
                </button>
              </div>
              <textarea
                className="input mono"
                rows={4}
                placeholder={
                  isClaude
                    ? 'Paste Claude .credentials.json contents ({"claudeAiOauth": ...} or {"ANTHROPIC_API_KEY": ...})'
                    : 'Paste Codex auth.json contents ({"tokens": ...} or {"OPENAI_API_KEY": ...})'
                }
                aria-label={`${cliTitle} ${importFileLabel} contents`}
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

          {state.accounts.length > 1 && (
            <button
              type="button"
              className={`btn btn-sm${reordering ? ' is-active' : ''}`}
              aria-pressed={reordering}
              onClick={() => setReordering(!reordering)}
            >
              {reordering ? 'Done reordering' : 'Reorder accounts'}
            </button>
          )}
          {reordering && (
            <p className="faint">
              Drag a handle to reorder. With a keyboard, focus a handle and use Up or Down.
            </p>
          )}
          <ul className="list codex-accounts-list">
            <li className="codex-account-row">
              <span
                className={`status-dot${defaultInUse ? ' green' : ''}`}
                role="img"
                aria-label={defaultInUse ? 'Active account' : 'Inactive account'}
              />
              <span className="codex-account-info">
                <b>Default {cliTitle} account</b>{' '}
                <span className="faint" style={{ fontSize: 12.5 }}>
                  (<code>{credFile}</code>)
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
                {state.defaultAccount && (
                  <AccountUsage account={state.defaultAccount} loading={loadingUsage} now={now} />
                )}
              </span>
              <span className="actions codex-account-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || loadingUsage}
                  aria-label="Refresh usage for default account"
                  title="Refresh usage for default account"
                  onClick={() =>
                    void act(() =>
                      isClaude ? api.getClaudeAccounts() : api.refreshCodexAccountUsage('default'),
                    )
                  }
                >
                  <AccountActionIcon action="refresh" />
                </button>
                {defaultInUse ? (
                  <span className="badge badge-done">active</span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    aria-label="Use default"
                    title="Switch to default account"
                    onClick={() =>
                      act(() =>
                        isClaude
                          ? api.setActiveClaudeAccount(null)
                          : api.setActiveCodexAccount(null),
                      )
                    }
                  >
                    <AccountActionIcon action="switch" />
                    <span className="account-action-label">Use default</span>
                  </button>
                )}
              </span>
            </li>

            {orderedAccounts.map((acc) => {
              const isActive = state.activeProfileId === acc.id;
              const isRenaming = renamingId === acc.id;
              const sameAsEmail =
                Boolean(acc.email) &&
                acc.email!.trim().toLowerCase() === acc.name.trim().toLowerCase();
              const showEmail = Boolean(acc.email) && !sameAsEmail;
              return (
                <li
                  key={acc.id}
                  data-account-id={acc.id}
                  className={`codex-account-row${draggingId === acc.id ? ' is-reordering' : ''}`}
                >
                  {reordering && (
                    <button
                      type="button"
                      className="btn btn-sm account-drag-handle"
                      aria-label={`Reorder ${acc.name}`}
                      title="Drag to reorder; Up/Down keys also move this account"
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                          e.preventDefault();
                          moveAccount(acc.id, e.key === 'ArrowUp' ? -1 : 1);
                        }
                      }}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        e.currentTarget.focus();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        setDraggingId(acc.id);
                      }}
                      onPointerMove={(e) => {
                        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                        const target = document
                          .elementFromPoint(e.clientX, e.clientY)
                          ?.closest('[data-account-id]')
                          ?.getAttribute('data-account-id');
                        if (target && target !== acc.id) {
                          const from = orderedAccounts.findIndex((a) => a.id === acc.id),
                            to = orderedAccounts.findIndex((a) => a.id === target);
                          moveAccount(acc.id, to - from);
                        }
                      }}
                      onPointerUp={(e) => {
                        if (e.currentTarget.hasPointerCapture(e.pointerId))
                          e.currentTarget.releasePointerCapture(e.pointerId);
                        setDraggingId(null);
                      }}
                      onPointerCancel={() => setDraggingId(null)}
                    >
                      ⠿
                    </button>
                  )}
                  <span
                    className={`status-dot${isActive ? ' green' : ''}`}
                    role="img"
                    aria-label={isActive ? 'Active account' : 'Saved account'}
                  />
                  <span className="codex-account-info">
                    {isRenaming ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type="text"
                          className="input"
                          value={renameDraft}
                          title={
                            sameAsEmail ? `Add nickname for ${acc.name}` : `Rename ${acc.name}`
                          }
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
                        <span className="codex-account-heading">
                          <span className="codex-account-identity">
                            <b>{acc.name}</b>
                            {showEmail && (
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
                          </span>
                          {!isClaude && state.autoSwitch && (
                            <label className="codex-account-auto-switch">
                              <input
                                type="checkbox"
                                checked={acc.autoSwitchEligible !== false}
                                disabled={busy}
                                aria-label={`Include ${acc.name} in automatic switching`}
                                onChange={(event) =>
                                  act(() =>
                                    api.setCodexAccountAutoSwitchEligible(
                                      acc.id,
                                      event.target.checked,
                                    ),
                                  )
                                }
                              />
                              Auto-switch
                            </label>
                          )}
                          {acc.createdAt && (
                            <span
                              className="faint"
                              style={{ fontSize: 12 }}
                              title={`Saved ${formatDate(acc.createdAt)}, ${new Date(acc.createdAt).toLocaleTimeString()}`}
                            >
                              {' '}
                              · saved {formatRelative(acc.createdAt)}
                            </span>
                          )}
                        </span>
                      </>
                    )}
                    <AccountUsage account={acc} loading={loadingUsage} now={now} />
                  </span>
                  <span className="actions codex-account-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy || loadingUsage}
                      aria-label={`Refresh usage for ${acc.name}`}
                      title={`Refresh usage for ${acc.name}`}
                      onClick={() =>
                        void act(() =>
                          isClaude ? api.getClaudeAccounts() : api.refreshCodexAccountUsage(acc.id),
                        )
                      }
                    >
                      <AccountActionIcon action="refresh" />
                    </button>
                    {isActive ? (
                      <span className="badge badge-done">active</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        aria-label={`Switch to account ${acc.name}`}
                        title={`Switch to ${acc.name}`}
                        onClick={() =>
                          act(() =>
                            isClaude
                              ? api.setActiveClaudeAccount(acc.id)
                              : api.setActiveCodexAccount(acc.id),
                          )
                        }
                      >
                        <AccountActionIcon action="switch" />
                        <span className="account-action-label">Switch to account</span>
                      </button>
                    )}
                    {!isRenaming && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        aria-label={`Rename ${acc.name}`}
                        title={sameAsEmail ? `Add nickname for ${acc.name}` : `Rename ${acc.name}`}
                        onClick={() => {
                          setRenamingId(acc.id);
                          setRenameDraft(acc.name);
                        }}
                      >
                        <AccountActionIcon action="rename" />
                        <span className="account-action-label">
                          {sameAsEmail ? 'Add nickname' : 'Rename'}
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() =>
                        act(() =>
                          isClaude
                            ? api.removeClaudeAccount(acc.id)
                            : api.removeCodexAccount(acc.id),
                        )
                      }
                      title={`Remove ${acc.name}`}
                      aria-label={`Remove ${acc.name}`}
                    >
                      <AccountActionIcon action="remove" />
                      <span className="account-action-label">Remove</span>
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * One account's usage, on its own line under the account (PM-173): what is known and when it
 * was checked, with the meters. While a refresh runs, known meters stay and are marked
 * updating; an account with none yet says it is loading.
 */
function AccountUsage({
  account,
  loading,
  now,
}: {
  account: Pick<CodexAccount, 'usageStatus' | 'usageCheckedAt' | 'limits'>;
  loading: boolean;
  now: number;
}) {
  const label =
    loading && !account.limits
      ? 'Loading usage…'
      : usageLabel(account.usageStatus, account.usageCheckedAt) + (loading ? ' · updating…' : '');
  return (
    <span className="codex-account-usage">
      <span className="faint codex-account-usage-status" role="status">
        {label}
      </span>
      {account.limits && <UsageLimits limits={account.limits} now={now} />}
    </span>
  );
}

function usageLabel(
  status?: import('../../../shared/types').AccountUsageStatus,
  checkedAt?: string | null,
): string {
  switch (status) {
    case 'fresh':
      return 'Usage checked just now';
    case 'stale':
      return checkedAt
        ? `Usage checked ${formatRelative(checkedAt)}`
        : 'Last reported usage (may be out of date)';
    case 'expired':
      return 'Signed out: run codex login with this account, then save the login again';
    case 'unavailable':
      return 'Usage unavailable; try refreshing later';
    case 'unsupported':
      return 'Account usage is unavailable for this login type';
    default:
      return 'Usage not refreshed';
  }
}
