export interface ProjectBranch {
  name: string;
  remote: boolean;
  current: boolean;
  hash: string;
  subject: string;
  committedAt: string;
  upstream: string | null;
  tracking: string;
  worktree: boolean;
}
export interface ProjectBranches {
  isRepo: boolean;
  current: string | null;
  detached: boolean;
  head: string | null;
  branches: ProjectBranch[];
  truncated: boolean;
}
