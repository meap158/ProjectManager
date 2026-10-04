import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { CARD_STATUS_LABELS, type ProjectDetail } from '../../../shared/types';
import { api } from '../api';
import { AgentsPanel } from '../components/AgentsPanel';
import {
  HEAT_SCALE,
  HorizontalBars,
  LanguageBar,
  MonthlyCommits,
  languageSlices,
  toContributions,
} from '../components/charts';
import { KanbanBoard } from '../components/KanbanBoard';
import { BytesTile, StatTile } from '../components/StatTile';
import { DeleteButton } from '../components/ui/delete-button';
import { GitHubActivity } from '../components/ui/github-activity';
import { GooeyNav } from '../components/ui/gooey-nav';
import { formatBytes, formatDate, formatNumber, formatRelative } from '../format';

const POLL_MS = 1000;
const TABS = ['overview', 'board', 'agents'] as const;
type Tab = (typeof TABS)[number];

function parseTab(value: string | null): Tab {
  return value === 'board' || value === 'agents' ? value : 'overview';
}

export function ProjectPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get('tab'));

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cardsVersion, setCardsVersion] = useState(0);
  const wasScanning = useRef(false);

  // Only sets state in promise callbacks, so effects may call it directly.
  const load = useCallback(
    () =>
      api.getProject(id).then(
        (next) => {
          // A scan just finished: it may have moved cards, so refresh the board too.
          if (wasScanning.current && next.scan.status !== 'scanning') setCardsVersion((v) => v + 1);
          wasScanning.current = next.scan.status === 'scanning';
          setProject(next);
          setError(null);
        },
        (e: Error) => setError(e.message),
      ),
    [id],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (project?.scan.status !== 'scanning') return;
    const timer = setTimeout(load, POLL_MS);
    return () => clearTimeout(timer);
  }, [project, load]);

  async function rescan() {
    try {
      setProject(await api.scanProject(id));
      wasScanning.current = true;
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error && !project) {
    return (
      <main className="page">
        <div className="error-banner">{error}</div>
        <Link to="/">← Back to projects</Link>
      </main>
    );
  }
  if (!project) {
    return (
      <main className="page" aria-busy="true">
        <div className="skeleton" style={{ height: 48, width: 320 }} />
        <div className="skeleton" style={{ height: 320 }} />
      </main>
    );
  }

  const scanning = project.scan.status === 'scanning';

  return (
    <main className="page">
      <div className="page-header">
        <div style={{ minWidth: 0 }}>
          <ProjectTitle project={project} onRenamed={setProject} />
          <div className="subtitle">
            <span className="mono truncate" title={project.path}>
              {project.path}
            </span>
            {project.git?.branch && <span className="badge mono">⎇ {project.git.branch}</span>}
            {project.git?.remoteUrl && (
              <span className="faint mono truncate" title="origin">
                {project.git.remoteUrl}
              </span>
            )}
          </div>
        </div>
        <div className="actions" style={{ alignItems: 'center' }}>
          <span className="faint" style={{ fontSize: 12.5 }}>
            {scanning ? 'Scanning…' : `Scanned ${formatRelative(project.lastScannedAt)}`}
          </span>
          <button className="btn" onClick={rescan} disabled={scanning || project.missing}>
            {scanning ? <span className="spinner" /> : '↻'} Refresh
          </button>
          <DeleteButton
            title="Stop tracking (files on disk are not touched)"
            onConfirm={async () => {
              try {
                await api.removeProject(id);
                navigate('/');
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
        </div>
      </div>

      {project.missing && (
        <div className="error-banner">
          This folder no longer exists on disk. Showing the last scan results.
        </div>
      )}
      {project.scan.status === 'error' && (
        <div className="error-banner">Last scan failed: {project.scan.error}</div>
      )}
      {error && <div className="error-banner">{error}</div>}
      {project.scan.moves.length > 0 && (
        <div className="notice" role="status">
          <span>
            Moved by commits:{' '}
            {project.scan.moves.map((m) => `${m.key} → ${CARD_STATUS_LABELS[m.to]}`).join(', ')}
          </span>
          <button className="btn btn-sm" onClick={() => setParams({ tab: 'board' })}>
            View board
          </button>
        </div>
      )}

      <GooeyNav
        items={['Overview', 'Board', 'Agents']}
        value={TABS.indexOf(tab)}
        onChange={(i) => setParams(TABS[i] === 'overview' ? {} : { tab: TABS[i]! })}
        activeColor="var(--accent)"
        size="sm"
        aria-label="Project sections"
      />

      {tab === 'overview' ? (
        <Overview project={project} />
      ) : tab === 'board' ? (
        <KanbanBoard projectId={id} reloadKey={cardsVersion} />
      ) : (
        <AgentsPanel projectId={id} />
      )}
    </main>
  );
}

function ProjectTitle({
  project,
  onRenamed,
}: {
  project: ProjectDetail;
  onRenamed: (p: ProjectDetail) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);

  async function save() {
    setEditing(false);
    if (name.trim() && name.trim() !== project.name) {
      onRenamed(await api.renameProject(project.id, name.trim()));
    }
  }

  if (editing) {
    return (
      <input
        className="input"
        style={{ fontSize: 20, fontWeight: 650, maxWidth: 420 }}
        value={name}
        autoFocus
        aria-label="Project name"
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') {
            setName(project.name);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <h1>
      <button
        className="btn-ghost"
        style={{
          font: 'inherit',
          background: 'none',
          border: 0,
          padding: 0,
          color: 'inherit',
          cursor: 'text',
        }}
        title="Rename"
        onClick={() => (setName(project.name), setEditing(true))}
      >
        {project.name}
      </button>
    </h1>
  );
}

function Overview({ project }: { project: ProjectDetail }) {
  const { code, disk, git } = project;

  if (!code || !disk || !git) {
    return (
      <div className="panel empty" aria-busy="true">
        <span className="spinner" />
        <h2>Scanning this folder…</h2>
        <p style={{ margin: 0 }}>Counting lines, measuring size on disk and reading git history.</p>
      </div>
    );
  }

  const slices = languageSlices(code.languages);
  const colorOf = new Map(slices.map((s) => [s.name, s.color]));

  return (
    <>
      <section className="stats" aria-label="Key numbers">
        <StatTile
          label="Lines of code"
          value={code.code}
          hint={`${formatNumber(code.comments)} comments · ${formatNumber(code.blanks)} blank`}
        />
        <StatTile
          label="Source files"
          value={code.totalFiles}
          hint={`${formatNumber(code.countedFiles)} in known languages`}
        />
        <StatTile
          label="Folders"
          value={code.folders}
          hint={`${formatNumber(disk.folders)} incl. ignored`}
        />
        <BytesTile
          label="Size on disk"
          bytes={disk.bytes}
          hint={`${formatNumber(disk.files)} files in total`}
        />
        <BytesTile
          label="Source size"
          bytes={code.bytes}
          hint={git.isRepo ? 'tracked + unignored' : 'excl. dependencies'}
        />
        <StatTile
          label="Complexity"
          value={code.complexity}
          hint={
            code.code
              ? `${((code.complexity / code.code) * 100).toFixed(1)} per 100 lines`
              : undefined
          }
        />
        <StatTile
          label="Commits"
          value={git.totalCommits}
          hint={git.isRepo ? undefined : 'Not a git repository'}
        />
        <StatTile label="Contributors" value={git.contributors.length} />
        <StatTile
          label="Last commit"
          text={formatRelative(git.lastCommitAt)}
          hint={formatDate(git.lastCommitAt)}
        />
        <StatTile
          label="First commit"
          text={formatDate(git.firstCommitAt)}
          hint={git.firstCommitAt ? formatRelative(git.firstCommitAt) : undefined}
        />
      </section>

      {(code.truncated || disk.truncated) && (
        <div className="notice">
          This folder is very large; some numbers stop at the scan limit.
        </div>
      )}

      {git.isRepo && (
        <section className="grid grid-2">
          <div className="panel">
            <div className="panel-header">
              <h2>Commit activity</h2>
              <span className="meta">Author dates · hover a day</span>
            </div>
            <GitHubActivity
              contributions={toContributions(git.dailyCommits)}
              repos={git.contributors.slice(0, 5).map((c) => ({ name: c.name, count: c.commits }))}
              label="Top contributors"
              unit="commit"
              accent={HEAT_SCALE}
              showMonths
              className="w-full rounded-none bg-transparent p-0 pb-[68px] dark:bg-transparent"
              style={{ width: '100%' }}
            />
          </div>
          <div className="panel">
            <div className="panel-header">
              <h2>Commits per month</h2>
              <span className="meta">Last 12 months</span>
            </div>
            <MonthlyCommits dailyCommits={git.dailyCommits} />
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-header">
          <h2>Languages</h2>
          <span className="meta">
            {code.engine === 'scc' ? 'Counted with scc' : 'Built-in counter'} · by lines of code
          </span>
        </div>
        {code.languages.length === 0 ? (
          <p className="faint">No recognised source files.</p>
        ) : (
          <>
            <LanguageBar languages={code.languages} />
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Language</th>
                    <th className="r">Files</th>
                    <th className="r">Code</th>
                    <th className="r">Comments</th>
                    <th className="r">Blank</th>
                    <th className="r">Complexity</th>
                    <th className="r">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {code.languages.map((l) => (
                    <tr key={l.name}>
                      <td>
                        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                          <i
                            className="swatch"
                            style={{ background: colorOf.get(l.name) ?? 'var(--series-other)' }}
                          />
                          {l.name}
                        </span>
                      </td>
                      <td className="r">{formatNumber(l.files)}</td>
                      <td className="r">{formatNumber(l.code)}</td>
                      <td className="r">{formatNumber(l.comments)}</td>
                      <td className="r">{formatNumber(l.blanks)}</td>
                      <td className="r">{formatNumber(l.complexity)}</td>
                      <td className="r">{formatBytes(l.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="grid grid-2">
        <div className="panel">
          <div className="panel-header">
            <h2>Size on disk by folder</h2>
            <span className="meta">
              {git.isRepo && disk.gitBytes > 0 && `.git ${formatBytes(disk.gitBytes)} · `}
              top level
            </span>
          </div>
          <HorizontalBars
            rows={disk.topFolders.map((f) => ({
              label: f.name,
              value: f.bytes,
              hint: `${formatNumber(f.files)} files`,
            }))}
            format={formatBytes}
          />
        </div>
        <div className="panel">
          <div className="panel-header">
            <h2>Largest source files</h2>
          </div>
          <ul className="list">
            {code.largestFiles.map((f) => (
              <li key={f.path}>
                <span className="mono truncate" style={{ flex: 1 }} title={f.path}>
                  {f.path}
                </span>
                <span className="faint num">{f.lines ? `${formatNumber(f.lines)} lines` : ''}</span>
                <span className="num" style={{ minWidth: 64, textAlign: 'right' }}>
                  {formatBytes(f.bytes)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {git.isRepo && (
        <section className="grid grid-2">
          <div className="panel">
            <div className="panel-header">
              <h2>Recent commits</h2>
            </div>
            <ul className="list">
              {git.recentCommits.map((c) => (
                <li key={c.hash}>
                  <code className="faint">{c.hash.slice(0, 7)}</code>
                  <span className="truncate" style={{ flex: 1 }} title={c.subject}>
                    {c.subject}
                  </span>
                  <span className="faint" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>
                    {c.author} · {formatRelative(c.date)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="panel">
            <div className="panel-header">
              <h2>Contributors</h2>
            </div>
            <HorizontalBars
              rows={git.contributors.map((c) => ({
                label: c.name,
                value: c.commits,
                hint: c.email,
              }))}
              format={(n) => `${formatNumber(n)} commits`}
            />
          </div>
        </section>
      )}
    </>
  );
}
