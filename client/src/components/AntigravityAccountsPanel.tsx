import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeAccount, NativeAccountsState } from '../../../shared/nativeAccounts';
import { api } from '../api';
import { serialPoll } from '../lib/serialPoll';
import { useViewPreference } from '../useViewPreference';
import { AccountActionIcon } from './CodexAccountsPanel';
import { ProviderIcon } from './icons';
import { UsageLimits } from './UsageLimits';
import { ConfirmDelete } from './ConfirmDelete';

function AccountToolbarAction({
  kind,
  label,
  disabled,
  onClick,
  primary = false,
}: {
  kind: 'refresh' | 'save' | 'import';
  label: string;
  disabled: boolean;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={`btn btn-sm${primary ? ' btn-primary' : ''}`}
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <AccountActionIcon action={kind} />
      <span className="account-action-label">{label}</span>
    </button>
  );
}

export function AntigravityAccountsPanel() {
  return <NativeAccountsPanel providerId="antigravity" />;
}
export function NativeAccountsPanel({ providerId }: { providerId: 'antigravity' | 'grok' }) {
  const isGrok = providerId === 'grok';
  const title = isGrok ? 'Grok' : 'Antigravity';
  const methods = useMemo(
    () =>
      isGrok
        ? {
            get: api.getGrokAccounts,
            refresh: api.refreshGrokAccounts,
            refreshOne: api.refreshGrokAccount,
            save: api.saveGrokAccount,
            import: api.importGrokAccount,
            switch: api.switchGrokAccount,
            rename: api.renameGrokAccount,
            remove: api.removeGrokAccount,
          }
        : {
            get: api.getAntigravityAccounts,
            refresh: api.refreshAntigravityAccounts,
            refreshOne: api.refreshAntigravityAccount,
            save: api.saveAntigravityAccount,
            import: api.importAntigravityAccount,
            switch: api.switchAntigravityAccount,
            rename: api.renameAntigravityAccount,
            remove: api.removeAntigravityAccount,
          },
    [isGrok],
  );
  const [now] = useState(() => Date.now());
  const [state, setState] = useState<NativeAccountsState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const acting = useRef(false),
    fileRef = useRef<HTMLInputElement>(null);
  const actionRevision = useRef(0);
  const [chosen, setChosen] = useState<string | null>(null),
    [renaming, setRenaming] = useState<string | null>(null),
    [draft, setDraft] = useState('');
  const [reordering, setReordering] = useState(false);
  const [order, setOrder] = useViewPreference<string[]>(
    `pm.accounts.order.${providerId}`,
    [],
    (v): v is string[] => Array.isArray(v) && v.every((id) => typeof id === 'string'),
  );
  useEffect(() => {
    let mounted = true;
    let revision = 0;
    const load = async () => {
      if (acting.current) return;
      const started = ++revision;
      const actionAtStart = actionRevision.current;
      try {
        const next = await methods.get();
        if (
          mounted &&
          !acting.current &&
          started === revision &&
          actionAtStart === actionRevision.current
        )
          setState(next);
      } catch {
        if (mounted && actionAtStart === actionRevision.current)
          setError(`Unable to read ${title} accounts.`);
      }
    };
    const stop = serialPoll(load, isGrok ? 5000 : 60000, { pauseWhenHidden: true });
    return () => {
      mounted = false;
      stop();
    };
  }, [isGrok, methods, title]);
  const act = useCallback(async (fn: () => Promise<NativeAccountsState>) => {
    if (acting.current) return;
    acting.current = true;
    actionRevision.current++;
    setBusy(true);
    setError('');
    try {
      setState(await fn());
      setChosen(null);
      setRenaming(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }, []);
  const rows = [...(state?.accounts ?? [])].sort(
    (a, b) =>
      (order.indexOf(a.id) < 0 ? order.length : order.indexOf(a.id)) -
      (order.indexOf(b.id) < 0 ? order.length : order.indexOf(b.id)),
  );
  function move(id: string, target: number) {
    const ids = rows.map((a) => a.id),
      from = ids.indexOf(id);
    if (from < 0 || target < 0 || target >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(target, 0, id);
    setOrder(ids);
  }
  function usage(a: NativeAccount | null | undefined) {
    const windows = [
      { label: '5-hour', windowMinutes: 300, usedPercent: a?.usage.fiveHour },
      { label: 'Weekly', windowMinutes: 10080, usedPercent: a?.usage.weekly },
    ].filter(
      (w): w is { label: string; windowMinutes: number; usedPercent: number } =>
        typeof w.usedPercent === 'number',
    );
    return (
      <span className="codex-account-usage">
        <span className="codex-account-usage-status faint">
          {busy
            ? 'Updating...'
            : a?.usageStatus === 'expired'
              ? `Login expired: sign in with ${isGrok ? 'grok' : 'agy'}, then save the login again`
              : a?.usageStatus === 'unavailable'
                ? 'Usage unavailable; try refreshing later'
                : a?.usageStatus === 'stale'
                  ? 'Usage may be out of date; refreshing'
                  : a?.usage.updatedAt
                    ? `Usage checked ${new Date(a.usage.updatedAt).toLocaleString()}`
                    : 'Usage not refreshed'}
        </span>
        {(a?.limits || windows.length > 0) && (
          <UsageLimits
            now={now}
            limits={
              a?.limits ?? {
                providerId,
                source: `${title} account service`,
                asOf: a?.usage.updatedAt ?? '',
                windows: windows.map((w) => ({ ...w, resetsAt: null })),
              }
            }
          />
        )}
      </span>
    );
  }
  function row(a: NativeAccount | null, isDefault = false) {
    const id = isDefault ? 'default' : a!.id;
    return (
      <li key={id} data-account-id={id} className="codex-account-row">
        {reordering && !isDefault && (
          <button
            type="button"
            className="btn btn-sm account-drag-handle"
            aria-label={`Reorder ${a!.name}`}
            title="Drag to reorder; Up/Down keys also move this account"
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                move(id, rows.findIndex((x) => x.id === id) + (e.key === 'ArrowUp' ? -1 : 1));
              }
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.currentTarget.focus();
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
              const target = document
                .elementFromPoint(e.clientX, e.clientY)
                ?.closest('[data-account-id]')
                ?.getAttribute('data-account-id');
              if (target && target !== id)
                move(
                  id,
                  rows.findIndex((x) => x.id === target),
                );
            }}
            onPointerUp={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
              <circle cx="5" cy="4" r="1" />
              <circle cx="11" cy="4" r="1" />
              <circle cx="5" cy="8" r="1" />
              <circle cx="11" cy="8" r="1" />
              <circle cx="5" cy="12" r="1" />
              <circle cx="11" cy="12" r="1" />
            </svg>
          </button>
        )}
        <span
          className={`status-dot${a?.active ? ' green' : ''}`}
          role="img"
          aria-label={a?.active ? 'Active account' : 'Saved account'}
        />
        <span className="codex-account-info">
          <span className="codex-account-heading">
            <b>{isDefault ? `Default ${title} account` : a!.name}</b>
            {isDefault && (
              <span className="faint">
                {' '}
                · {a ? a.email || 'email unavailable' : 'not signed in'}
              </span>
            )}
            {!isDefault && a?.email && a.email !== a.name && (
              <span className="faint"> · {a.email}</span>
            )}
            {a?.plan && <span className="badge">{a.plan}</span>}
          </span>
          {usage(a)}
        </span>
        <span className="actions codex-account-actions">
          {a?.active && <span className="badge badge-done">active</span>}
          <AccountToolbarAction
            kind="refresh"
            label={`Refresh usage for ${isDefault ? 'default account' : a!.name}`}
            disabled={busy}
            onClick={() => void act(() => methods.refreshOne(id))}
          />
          {!isDefault && (
            <>
              {!a!.active && (
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  aria-label={`Switch to account ${a!.name}`}
                  onClick={() => setChosen(id)}
                >
                  <AccountActionIcon action="switch" />
                  <span className="account-action-label">Switch to account</span>
                </button>
              )}
              <button
                className="btn btn-sm"
                disabled={busy}
                aria-label={`Add nickname for ${a!.name}`}
                onClick={() => {
                  setRenaming(id);
                  setDraft(a!.name);
                }}
              >
                <AccountActionIcon action="rename" />
                <span className="account-action-label">Add nickname</span>
              </button>
              <ConfirmDelete
                small
                label={`Remove ${a!.name}`}
                text="Remove"
                heading={`Remove ${a!.name}?`}
                message="Removes only the saved profile. The current CLI login and running sessions remain available."
                onConfirm={() => act(() => methods.remove(id)).then(() => undefined)}
                disabled={busy}
              />
            </>
          )}
        </span>
        {renaming === id && (
          <form
            className="actions"
            onSubmit={(e) => {
              e.preventDefault();
              void act(() => methods.rename(id, draft));
            }}
          >
            <input
              className="input"
              aria-label={`Rename ${a!.name}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={160}
            />
            <button className="btn btn-primary btn-sm" disabled={busy || !draft.trim()}>
              Save
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </form>
        )}
        {chosen === id && (
          <div>
            <p>Use {a!.name} for new launches? Running sessions will keep their current login.</p>
            <button
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => void act(() => methods.switch(id))}
            >
              Confirm switch
            </button>{' '}
            <button className="btn btn-sm" onClick={() => setChosen(null)}>
              Cancel
            </button>
          </div>
        )}
      </li>
    );
  }
  return (
    <div className="codex-accounts-panel" role="region" aria-label={`${title} accounts`}>
      <div
        className="panel-header"
        style={{ marginBottom: 6, paddingBottom: 0, borderBottom: 'none' }}
      >
        <span className="actions">
          <ProviderIcon id={providerId} size={14} />
          <strong style={{ fontSize: 13 }}>{title} accounts</strong>
        </span>
        <span className="meta">
          active:{' '}
          {state?.defaultAccount?.email ||
            state?.accounts.find((a) => a.active)?.email ||
            (state?.defaultAccount || state?.accounts.some((a) => a.active)
              ? 'signed in (email unavailable)'
              : 'not signed in')}
        </span>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {!state && !error && <div className="skeleton" style={{ height: 100 }} />}
      {state && !state.available && (
        <p>Native {title} account management is unavailable on this platform.</p>
      )}
      {state?.available && (
        <>
          <p className="faint">
            Switching changes the login for new {title} launches. Existing sessions keep their login
            until restarted.
          </p>
          <div className="codex-accounts-toolbar">
            <span className="faint">Saved logins are encrypted locally.</span>
            <span className="actions codex-accounts-toolbar-actions">
              <AccountToolbarAction
                kind="refresh"
                label="Refresh usage"
                disabled={busy}
                onClick={() => void act(methods.refresh)}
              />
              <AccountToolbarAction
                kind="save"
                label="Save current CLI login"
                disabled={busy}
                onClick={() => void act(methods.save)}
              />
              <AccountToolbarAction
                kind="import"
                label="Import credential file"
                primary
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              />
            </span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            aria-label={`${title} credential file`}
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              if (file.size > 65536) {
                setError('Credential file is too large.');
                return;
              }
              await act(async () => methods.import(await file.text()));
            }}
          />
          {rows.length > 1 && (
            <button
              type="button"
              className="btn btn-sm"
              aria-pressed={reordering}
              onClick={() => setReordering(!reordering)}
            >
              {reordering ? 'Done reordering' : 'Reorder accounts'}
            </button>
          )}
          {reordering && <p className="faint">Drag a handle, or focus it and use Up/Down.</p>}
          <ul className="list codex-accounts-list">
            {row(state.defaultAccount ?? null, true)}
            {rows.map((a) => row(a))}
          </ul>
          {!rows.length && (
            <p className="faint">
              No saved accounts. Save the current CLI login or import a credential file.
            </p>
          )}
        </>
      )}
    </div>
  );
}
