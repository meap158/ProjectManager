import type { ProjectSummary } from './types.js';
export function projectAttention(
  project: ProjectSummary,
  now = Date.now(),
  dismissedKinds: string[] = [],
) {
  const items: { kind: string; detail: string }[] = [];
  const git = project.git;
  if (project.missing) items.push({ kind: 'Folder missing', detail: project.path });
  else if (project.scan?.status === 'error')
    items.push({ kind: 'Scan failed', detail: project.scan?.error ?? 'Unknown error' });
  else if (git?.isRepo && git.lastCommitAt && now - Date.parse(git.lastCommitAt) > 90 * 86400000)
    items.push({ kind: 'Stale', detail: `No commits for over 90 days (last ${git.lastCommitAt})` });
  if (!project.missing && git?.dirtyFiles)
    items.push({
      kind: 'Uncommitted',
      detail: `${git.dirtyFiles} changed file${git.dirtyFiles === 1 ? '' : 's'}`,
    });
  if (!project.missing && git?.ahead)
    items.push({
      kind: 'Unpushed',
      detail: `${git.ahead} commit${git.ahead === 1 ? '' : 's'} not pushed to ${git.branch ?? 'upstream'}`,
    });
  return items.filter((i) => !dismissedKinds.includes(i.kind));
}
