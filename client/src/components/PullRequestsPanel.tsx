import { useCallback, useEffect, useId, useState } from 'react';
import { PR_MERGE_METHODS } from '../../../shared/types';
import type {
  PullRequest,
  PullRequestAccount,
  PullRequestAction,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestRepoSettings,
  PullRequestsResult,
} from '../../../shared/types';
import { api } from '../api';
import { formatRelative } from '../format';
import { ConfirmDelete } from './ConfirmDelete';
import { Dropdown } from './Dropdown';

const METHOD_LABEL: Record<PullRequestMergeMethod, { option: string; button: string }> = {
  merge: { option: 'Create a merge commit', button: 'Merge pull request' },
  squash: { option: 'Squash and merge', button: 'Squash and merge' },
  rebase: { option: 'Rebase and merge', button: 'Rebase and merge' },
};

const STATUS_LABEL: Record<PullRequest['mergeability']['status'], string> = {
  clean: 'Ready to merge',
  unstable: 'Mergeable',
  conflicts: 'Conflicts',
  behind: 'Behind base',
  blocked: 'Blocked',
  draft: 'Draft',
  checking: 'Checking…',
  closed: 'Closed',
};

/** Short state for the table: merge readiness while open, Merged/Closed after. */
function statusOf(pr: PullRequest): { label: string; tone: string } {
  if (pr.state === 'MERGED') return { label: 'Merged', tone: 'merged' };
  if (pr.state === 'CLOSED') return { label: 'Closed', tone: 'closed' };
  const status = pr.mergeability.status;
  const tone =
    status === 'clean'
      ? 'good'
      : status === 'conflicts' || (status === 'blocked' && pr.checks.failing)
        ? 'bad'
        : status === 'draft' || status === 'checking'
          ? 'neutral'
          : 'warn';
  return { label: STATUS_LABEL[status], tone };
}

function checksText(pr: PullRequest): string {
  const c = pr.checks;
  if (c.state === 'none') return 'No checks';
  return [
    c.failing && `${c.failing} failing`,
    c.pending && `${c.pending} pending`,
    c.passing && `${c.passing} passing`,
    c.skipped && `${c.skipped} skipped`,
  ]
    .filter(Boolean)
    .join(', ');
}

function reviewText(decision: string | null): string {
  if (decision === 'APPROVED') return 'Approved';
  if (decision === 'CHANGES_REQUESTED') return 'Changes requested';
  if (decision === 'REVIEW_REQUIRED') return 'Review required';
  return decision ? decision.toLowerCase().replaceAll('_', ' ') : 'Awaiting review';
}

export function PullRequestsPanel({ projectId, visible }: { projectId: number; visible: boolean }) {
  const [listState, setListState] = useState<PullRequestListState>('open');
  const [result, setResult] = useState<PullRequestsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(
    (state: PullRequestListState) =>
      api
        .pullRequests(projectId, state)
        .then(
          (next) => {
            setResult(next);
            setError(null);
          },
          (e: Error) => setError(e.message),
        )
        .finally(() => setBusy(false)),
    [projectId],
  );
  useEffect(() => {
    if (visible && !result) void load(listState);
  }, [visible, result, load, listState]);

  // Every action refreshes the list, so rows show GitHub's state rather than a guess. Errors
  // propagate to the row's action box, which shows gh's message inline.
  const act = useCallback(
    async (pr: PullRequest, action: PullRequestAction) => {
      const done = await api.pullRequestAction(projectId, pr.number, action);
      setMessage(done.message);
      setBusy(true);
      await load(listState);
    },
    [projectId, load, listState],
  );

  const plural = listState === 'open' ? 'open pull requests' : 'closed pull requests';
  return (
    <section
      className="panel"
      aria-label="Pull requests"
      aria-busy={busy || (visible && !result && !error)}
    >
      {/* The standard panel header (h2 + actions) and a 10px body rhythm, like every other
          panel: the header's button never sits on the banner below it (PM-40). */}
      <div className="panel-header">
        <h2>Pull requests</h2>
        <div className="actions" style={{ alignItems: 'center' }}>
          <div className="segmented" role="group" aria-label="Show pull requests">
            {(['open', 'closed'] as const).map((state) => (
              <button
                key={state}
                type="button"
                className={listState === state ? 'is-active' : undefined}
                aria-pressed={listState === state}
                onClick={() => {
                  if (state === listState) return;
                  setListState(state);
                  setResult(null);
                  setError(null);
                  setExpanded(null);
                  setMessage(null);
                }}
              >
                {state === 'open' ? 'Open' : 'Closed'}
              </button>
            ))}
          </div>
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void load(listState);
            }}
          >
            {busy ? 'Loading…' : 'Refresh pull requests'}
          </button>
        </div>
      </div>
      <div className="pr-body">
        {(error || result?.error) && (
          <div className="error-banner" role="alert">
            {error || result?.error}
          </div>
        )}
        {result?.account && (
          <AccountLine
            projectId={projectId}
            account={result.account}
            onChanged={() => {
              setBusy(true);
              void load(listState);
            }}
          />
        )}
        {message && (
          <div className="notice" role="status">
            <span>{message}</span>
            <button className="btn btn-sm btn-ghost" onClick={() => setMessage(null)}>
              Dismiss
            </button>
          </div>
        )}
        {result && !result.error && result.requests.length === 0 && (
          <p className="faint">No {plural}.</p>
        )}
        {!!result?.requests.length && (
          <div style={{ overflowX: 'auto' }}>
            <table className="table pr-table">
              <thead>
                <tr>
                  <th>Pull request</th>
                  <th>Author</th>
                  <th>Branches</th>
                  <th>Status</th>
                  <th>Checks</th>
                  <th>Review</th>
                  <th>Updated</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.requests.map((pr) => {
                  const open = expanded === pr.number;
                  return (
                    <PullRequestRow
                      key={pr.number}
                      pr={pr}
                      open={open}
                      repo={result.repo}
                      actingAs={result.account?.login ?? null}
                      onToggle={() => setExpanded(open ? null : pr.number)}
                      onAction={(action) => act(pr, action)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {result && (
          <p className="faint">
            Up to 100 {plural} · Fetched {formatRelative(result.fetchedAt)}
          </p>
        )}
      </div>
    </section>
  );
}

const AUTO = '';

/**
 * Which GitHub account gh acts as for this project, and (with several logged in) a choice of
 * another. Automatic means the account that owns the repo, else gh's active account.
 */
function AccountLine({
  projectId,
  account,
  onChanged,
}: {
  projectId: number;
  account: PullRequestAccount;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  const why =
    account.source === 'override'
      ? 'chosen for this project'
      : account.source === 'owner'
        ? `owner of ${account.owner ?? 'this repository'}`
        : account.owner
          ? `gh's active account: no logged-in account owns ${account.owner}`
          : "gh's active account";
  const choices = [...account.accounts];
  if (account.override && !choices.includes(account.override)) choices.push(account.override);
  const options = [
    { value: AUTO, label: 'Automatic (repository owner)' },
    ...choices.map((login) => ({
      value: login,
      label: login,
      hint: account.accounts.includes(login) ? undefined : 'not logged in',
    })),
  ];
  async function choose(value: string) {
    setSaving(true);
    setError(null);
    try {
      await api.setPullRequestAccount(projectId, value === AUTO ? null : value);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="pr-action-row">
      <p className="pr-merge-status">
        Acting as <strong>{account.login ?? 'no account'}</strong>{' '}
        <span className="faint">({why})</span>
      </p>
      {(choices.length > 1 || account.override) && (
        <>
          <label className="sr-only" htmlFor={selectId}>
            GitHub account
          </label>
          <Dropdown
            id={selectId}
            label="GitHub account"
            value={account.override ?? AUTO}
            options={options}
            onChange={(value) => void choose(value)}
            disabled={saving}
          />
        </>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function PullRequestRow({
  pr,
  open,
  repo,
  actingAs,
  onToggle,
  onAction,
}: {
  pr: PullRequest;
  open: boolean;
  repo: PullRequestRepoSettings | null;
  actingAs: string | null;
  onToggle: () => void;
  onAction: (action: PullRequestAction) => Promise<void>;
}) {
  const detailsId = useId();
  const status = statusOf(pr);
  return (
    <>
      <tr>
        <td>
          <a href={pr.url} target="_blank" rel="noreferrer">
            #{pr.number} {pr.title}
          </a>
          {pr.isDraft && pr.state === 'OPEN' && <span className="badge">Draft</span>}
          {pr.autoMerge && <span className="badge badge-tracked">Auto-merge</span>}
        </td>
        <td>{pr.author?.login || 'Deleted user'}</td>
        <td className="mono">
          {pr.headRefName} → {pr.baseRefName}
        </td>
        <td>
          <span className={`status-pill pr-pill-${status.tone}`}>{status.label}</span>
        </td>
        <td className={pr.checks.failing ? 'pr-text-bad' : undefined}>{checksText(pr)}</td>
        <td>{reviewText(pr.reviewDecision)}</td>
        <td>{formatRelative(pr.mergedAt ?? pr.closedAt ?? pr.updatedAt)}</td>
        <td>
          <button
            type="button"
            className="btn btn-sm"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={`${open ? 'Hide actions for' : 'Actions for'} #${pr.number}`}
            onClick={onToggle}
          >
            {open ? 'Hide' : 'Actions'}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="pr-details-row">
          <td colSpan={8} id={detailsId}>
            <PullRequestActions pr={pr} repo={repo} actingAs={actingAs} onAction={onAction} />
          </td>
        </tr>
      )}
    </>
  );
}

/** GitHub's merge box and branch controls for one pull request. */
export function PullRequestActions({
  pr,
  repo,
  actingAs = null,
  onAction,
}: {
  pr: PullRequest;
  repo: PullRequestRepoSettings | null;
  /** The GitHub account the server will act as, named in every confirmation. */
  actingAs?: string | null;
  onAction: (action: PullRequestAction) => Promise<void>;
}) {
  const allowed = repo?.mergeMethods ?? [...PR_MERGE_METHODS];
  const [method, setMethod] = useState<PullRequestMergeMethod>(allowed[0] ?? 'merge');
  const [deleteBranch, setDeleteBranch] = useState(repo?.deleteBranchOnMerge ?? false);
  const [bypass, setBypass] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const methodId = useId();
  const deleteId = useId();
  const bypassId = useId();

  async function run(label: string, action: PullRequestAction) {
    setWorking(label);
    setError(null);
    try {
      await onAction(action);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  }

  const m = pr.mergeability;
  const ownBranch = !pr.isCrossRepository;
  const isBusy = working !== null;
  const githubLink = (
    <a className="btn btn-sm btn-ghost" href={pr.url} target="_blank" rel="noreferrer">
      Open on GitHub
    </a>
  );
  const asWho = ` Acting as ${actingAs ?? "gh's active account"}.`;
  const errorBanner = error && (
    <div className="error-banner" role="alert">
      {error}
    </div>
  );

  if (pr.state !== 'OPEN') {
    const when = pr.state === 'MERGED' ? pr.mergedAt : pr.closedAt;
    return (
      <div className="pr-actions">
        <p className="pr-merge-status">
          {pr.state === 'MERGED' ? `Merged into ${pr.baseRefName}` : 'Closed without merging'}
          {when ? ` ${formatRelative(when)}` : ''}.{' '}
          {!ownBranch
            ? 'The head branch is in a fork.'
            : pr.headBranchExists === true
              ? `Branch ${pr.headRefName} still exists.`
              : pr.headBranchExists === false
                ? `Branch ${pr.headRefName} was deleted.`
                : `Couldn't tell whether ${pr.headRefName} still exists.`}
        </p>
        {errorBanner}
        <div className="pr-action-row">
          {pr.state === 'CLOSED' && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={isBusy}
              onClick={() => run('reopen', { action: 'reopen' })}
            >
              {working === 'reopen' ? 'Reopening…' : 'Reopen pull request'}
            </button>
          )}
          {ownBranch && pr.headBranchExists !== false && (
            <ConfirmDelete
              small
              label={`Delete branch ${pr.headRefName}`}
              text={working === 'delete' ? 'Deleting…' : 'Delete branch'}
              heading={`Delete branch ${pr.headRefName}?`}
              message={`Deletes ${pr.headRefName} on GitHub, and the local branch too when it isn't checked out and matches the pull request's head. It can be restored from here afterwards.${asWho}`}
              disabled={isBusy}
              onConfirm={() => run('delete', { action: 'delete-branch' })}
            />
          )}
          {ownBranch && pr.headBranchExists !== true && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={isBusy}
              onClick={() => run('restore', { action: 'restore-branch' })}
            >
              {working === 'restore' ? 'Restoring…' : 'Restore branch'}
            </button>
          )}
          {githubLink}
        </div>
      </div>
    );
  }

  const bypassing = bypass && m.canBypass;
  const canMergeNow = m.canMerge || bypassing;
  const methodOptions = PR_MERGE_METHODS.map((value) => {
    const ok = allowed.includes(value);
    return {
      value,
      label: METHOD_LABEL[value].option,
      disabled: !ok,
      hint: ok ? undefined : 'not allowed',
      title: ok ? undefined : 'Not allowed by this repository',
    };
  });
  const removeBranch = deleteBranch && ownBranch;
  const branchNote = removeBranch ? ` Branch ${pr.headRefName} is then deleted.` : '';
  return (
    <div className="pr-actions">
      <p className="pr-merge-status">
        <strong>{STATUS_LABEL[m.status]}.</strong>{' '}
        {m.reason ?? 'No conflicts with the base branch.'}{' '}
        <span className="faint">
          {reviewText(pr.reviewDecision)} · {checksText(pr)}
        </span>
      </p>
      {pr.checks.items.length > 0 && (
        <details className="pr-checks">
          <summary>Checks ({pr.checks.items.length})</summary>
          <ul>
            {pr.checks.items.map((check, i) => (
              <li key={`${check.name}-${i}`}>
                <span className={`badge pr-check-${check.state}`}>{check.state}</span>{' '}
                {check.url ? (
                  <a href={check.url} target="_blank" rel="noreferrer">
                    {check.name}
                  </a>
                ) : (
                  check.name
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {errorBanner}
      {pr.autoMerge && (
        <div className="notice">
          <span>
            Auto-merge is on
            {pr.autoMerge.method
              ? ` (${METHOD_LABEL[pr.autoMerge.method].option.toLowerCase()})`
              : ''}
            : GitHub merges this once its requirements pass.
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={isBusy}
            onClick={() => run('noauto', { action: 'disable-auto-merge' })}
          >
            {working === 'noauto' ? 'Disabling…' : 'Disable auto-merge'}
          </button>
        </div>
      )}
      <div className="pr-action-row">
        <label className="sr-only" htmlFor={methodId}>
          Merge method
        </label>
        <Dropdown
          id={methodId}
          label="Merge method"
          value={method}
          options={methodOptions}
          onChange={setMethod}
          disabled={isBusy}
        />
        <label className="pr-check-option" htmlFor={deleteId}>
          <input
            id={deleteId}
            type="checkbox"
            checked={removeBranch}
            disabled={!ownBranch || isBusy}
            onChange={(e) => setDeleteBranch(e.target.checked)}
          />
          Delete branch after merging or closing
        </label>
        {m.canBypass && (
          <label className="pr-check-option" htmlFor={bypassId}>
            <input
              id={bypassId}
              type="checkbox"
              checked={bypass}
              disabled={isBusy}
              onChange={(e) => setBypass(e.target.checked)}
            />
            Merge without waiting for requirements (admin)
          </label>
        )}
      </div>
      <div className="pr-action-row">
        <ConfirmDelete
          small
          tone="primary"
          icon={null}
          label={canMergeNow ? METHOD_LABEL[method].button : (m.reason ?? 'Cannot merge yet')}
          text={working === 'merge' ? 'Merging…' : METHOD_LABEL[method].button}
          heading={`${METHOD_LABEL[method].button}: #${pr.number}?`}
          message={`${METHOD_LABEL[method].option} of ${pr.headRefName} into ${pr.baseRefName}${bypassing ? ', bypassing branch protection' : ''}.${branchNote}${asWho}`}
          confirmLabel={METHOD_LABEL[method].button}
          disabled={!canMergeNow || isBusy}
          onConfirm={() =>
            run('merge', {
              action: 'merge',
              method,
              deleteBranch: removeBranch,
              auto: false,
              admin: bypassing,
              ...(/^[0-9a-f]{40}$/i.test(pr.headRefOid) ? { headOid: pr.headRefOid } : {}),
            })
          }
        />
        {m.canAutoMerge && (
          <ConfirmDelete
            small
            tone="primary"
            icon={null}
            label="Enable auto-merge"
            text={working === 'auto' ? 'Enabling…' : 'Enable auto-merge'}
            heading={`Enable auto-merge for #${pr.number}?`}
            message={`GitHub will ${METHOD_LABEL[method].option.toLowerCase()} once the required reviews and checks pass. Branch deletion then follows the repository's own setting.${asWho}`}
            confirmLabel="Enable auto-merge"
            disabled={isBusy}
            onConfirm={() =>
              run('auto', {
                action: 'merge',
                method,
                deleteBranch: false,
                auto: true,
                admin: false,
              })
            }
          />
        )}
        {m.canUpdateBranch && (
          <>
            <button
              type="button"
              className="btn btn-sm"
              disabled={isBusy}
              title="Merge the latest base branch into this branch"
              onClick={() => run('update', { action: 'update-branch', rebase: false })}
            >
              {working === 'update' ? 'Updating…' : 'Update branch'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={isBusy}
              title="Rebase this branch onto the latest base branch"
              onClick={() => run('rebase', { action: 'update-branch', rebase: true })}
            >
              {working === 'rebase' ? 'Rebasing…' : 'Update with rebase'}
            </button>
          </>
        )}
      </div>
      <div className="pr-action-row">
        {pr.isDraft ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={isBusy}
            onClick={() => run('ready', { action: 'ready' })}
          >
            {working === 'ready' ? 'Marking ready…' : 'Ready for review'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            disabled={isBusy}
            onClick={() => run('draft', { action: 'draft' })}
          >
            {working === 'draft' ? 'Converting…' : 'Convert to draft'}
          </button>
        )}
        <ConfirmDelete
          small
          icon={null}
          label={`Close pull request #${pr.number}`}
          text={working === 'close' ? 'Closing…' : 'Close pull request'}
          heading={`Close #${pr.number} without merging?`}
          message={`The pull request is closed, not merged, and can be reopened from the Closed list.${branchNote}${asWho}`}
          confirmLabel="Close pull request"
          disabled={isBusy}
          onConfirm={() => run('close', { action: 'close', deleteBranch: removeBranch })}
        />
        {githubLink}
      </div>
    </div>
  );
}
