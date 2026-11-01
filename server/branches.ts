import type { ProjectBranch, ProjectBranches } from '../shared/branches.js';
import { run } from './analysis/exec.js';
import { isGitRepo } from './analysis/fileList.js';

const REF_FORMAT =
  '--format=%(refname)%00%(objectname:short)%00%(subject)%00%(committerdate:iso-strict)%00%(upstream:short)%00%(upstream:track)%00%(worktreepath)%00%(symref)';

/** Local refs only. Never fetch, checkout or change the working tree. */
export async function projectBranches(root: string): Promise<ProjectBranches> {
  const empty: ProjectBranches = {
    isRepo: false,
    current: null,
    detached: false,
    head: null,
    branches: [],
    truncated: false,
  };
  if (!(await isGitRepo(root))) return empty;
  const git = async (args: string[]) =>
    (await run('git', args, { cwd: root, timeoutMs: 8000 })).stdout.trim();
  const [current, head, refs] = await Promise.all([
    git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null),
    git(['rev-parse', '--short', 'HEAD']).catch(() => null),
    git([
      'for-each-ref',
      '--sort=-committerdate',
      '--count=501',
      REF_FORMAT,
      'refs/heads',
      'refs/remotes',
    ]),
  ]);
  // A checked-out branch can be older than every ref in the capped recent list.
  const currentRef = current
    ? await git(['for-each-ref', REF_FORMAT, `refs/heads/${current}`])
    : '';
  const lines = new Map(
    [...refs.split('\n'), ...currentRef.split('\n')]
      .filter(Boolean)
      .map((line) => [line.split('\0')[0], line]),
  );
  const branches: ProjectBranch[] = [...lines.values()]
    .map((line) => {
      const [
        ref = '',
        hash = '',
        subject = '',
        committedAt = '',
        upstream = '',
        tracking = '',
        worktree = '',
        symref = '',
      ] = line.split('\0');
      if (symref) return null;
      const remote = ref.startsWith('refs/remotes/');
      const name = ref.replace(/^refs\/(heads|remotes)\//, '');
      return {
        name,
        remote,
        current: !remote && name === current,
        hash,
        subject,
        committedAt,
        upstream: upstream || null,
        tracking,
        worktree: Boolean(worktree),
      };
    })
    .filter((b): b is ProjectBranch => b !== null);
  return {
    isRepo: true,
    current,
    detached: current === null && head !== null,
    head,
    branches: [...branches.filter((b) => b.current), ...branches.filter((b) => !b.current)].slice(
      0,
      500,
    ),
    truncated: branches.length > 500,
  };
}
