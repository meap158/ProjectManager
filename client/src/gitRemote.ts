/**
 * The browser page for a git remote, or null when it isn't a web-hosted repo:
 *   git@github.com:owner/repo.git      -> https://github.com/owner/repo
 *   ssh://git@gitlab.com/group/repo    -> https://gitlab.com/group/repo
 *   https://github.com/owner/repo.git  -> https://github.com/owner/repo
 * Local paths and file:// remotes return null (nothing to open in a browser).
 */
export function remoteWebUrl(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const url = remote.trim();
  let host: string;
  let repoPath: string;
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(url);
  if (scp) {
    host = scp[1]!;
    repoPath = scp[2]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol) || !parsed.hostname) {
      return null;
    }
    host = parsed.hostname;
    repoPath = parsed.pathname.replace(/^\//, '');
  }
  repoPath = repoPath.replace(/\.git\/?$/, '').replace(/\/$/, '');
  if (!repoPath) return null;
  return `https://${host}/${repoPath}`;
}
