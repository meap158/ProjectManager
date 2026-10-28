import { run } from './analysis/exec.js';
import { GhAccountError, redactTokens, resolveGhIdentity } from './ghAccount.js';
import { parseGitHubIssueUrl } from './analysis/issueRefs.js';

export class GitHubIssueError extends Error {
  readonly status: 409 | 502;
  constructor(status: 409 | 502, message: string) {
    super(message);
    this.status = status;
  }
}

export interface CardIssueInput {
  id: number;
  key: string;
  title: string;
  description: string;
}

/**
 * Create a GitHub issue for a board card, in the project's own repository.
 *
 * Like every outward action here, this runs only when the owner asks for it: the only
 * caller is the explicit "Create GitHub issue" action on a card. The command is an
 * argument array (never a shell string), gh runs in the project folder (so it resolves
 * {owner}/{repo} from that project's remote), and it acts as the account ghAccount.ts
 * resolves for the project — the repo owner's login when it is logged in.
 */
export async function createCardIssue(
  cwd: string,
  card: CardIssueInput,
  override: string | null,
): Promise<{ url: string }> {
  let env: NodeJS.ProcessEnv | undefined;
  try {
    ({ env } = await resolveGhIdentity(cwd, override));
  } catch (error) {
    if (error instanceof GhAccountError) throw new GitHubIssueError(409, error.message);
    throw error;
  }
  const title = `[${card.key}] ${card.title}`.trim();
  const body = `${card.description.trim()}\n\n---\nFiled from the ProjectManager board (${card.key}).`;
  let stdout: string;
  try {
    ({ stdout } = await run('gh', ['issue', 'create', '--title', title, '--body', body], {
      cwd,
      timeoutMs: 30_000,
      ...(env ? { env } : {}),
    }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GitHubIssueError(502, redactTokens(`Could not create the issue: ${detail}`, env));
  }
  const url = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => parseGitHubIssueUrl(line) !== null);
  if (!url) {
    throw new GitHubIssueError(
      502,
      'GitHub did not return an issue URL. The issue may not have been created.',
    );
  }
  return { url };
}
