import type {
  AgentAutonomy,
  AgentOutput,
  AgentProviderStatus,
  AgentTerminal,
  AgentRun,
  AgentSession,
  BulkAddResult,
  Card,
  CardRunSummary,
  CardStatus,
  DirectoryListing,
  ProjectDetail,
  ProjectSummary,
} from '../../shared/types';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    // Always JSON: the server rejects non-JSON writes as a CSRF guard.
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  listProjects: () => request<ProjectSummary[]>('GET', '/projects'),
  getProject: (id: number) => request<ProjectDetail>('GET', `/projects/${id}`),
  addProject: (path: string, name?: string) =>
    request<ProjectDetail>('POST', '/projects', { path, name }),
  addProjects: (paths: string[]) => request<BulkAddResult>('POST', '/projects/batch', { paths }),
  renameProject: (id: number, name: string) =>
    request<ProjectDetail>('PATCH', `/projects/${id}`, { name }),
  removeProject: (id: number) => request<void>('DELETE', `/projects/${id}`),
  scanProject: (id: number) => request<ProjectDetail>('POST', `/projects/${id}/scan`),

  listCards: (projectId: number) => request<Card[]>('GET', `/projects/${projectId}/cards`),
  addCard: (
    projectId: number,
    input: { title: string; description?: string; status: CardStatus },
  ) => request<Card>('POST', `/projects/${projectId}/cards`, input),
  updateCard: (
    id: number,
    patch: Partial<Pick<Card, 'title' | 'description' | 'status' | 'position'>>,
  ) => request<Card>('PATCH', `/cards/${id}`, patch),
  deleteCard: (id: number) => request<void>('DELETE', `/cards/${id}`),

  browse: (path?: string) =>
    request<DirectoryListing>(
      'GET',
      `/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`,
    ),

  // ---- Agent CLI sessions and runs ------------------------------------------------------------
  listProviders: () => request<AgentProviderStatus[]>('GET', '/agents/providers'),
  listSessions: (projectId: number) =>
    request<AgentSession[]>('GET', `/projects/${projectId}/agent-sessions`),
  createSession: (
    projectId: number,
    input: {
      providerId?: string;
      command?: string[];
      name?: string;
      cwd?: string;
      supervise?: boolean;
      env?: Record<string, string>;
      terminal?: AgentTerminal;
    },
  ) => request<AgentSession>('POST', `/projects/${projectId}/agent-sessions`, input),
  patchSession: (id: number, patch: { name?: string; supervise?: boolean }) =>
    request<AgentSession>('PATCH', `/agent-sessions/${id}`, patch),
  sendSessionInput: (id: number, data: string) =>
    request<{ queued: boolean; session: AgentSession }>('POST', `/agent-sessions/${id}/input`, {
      data,
    }),
  sessionOutput: (id: number, after: number) =>
    request<AgentOutput>('GET', `/agent-sessions/${id}/output?after=${after}`),
  resizeSession: (id: number, cols: number, rows: number) =>
    request<{ ok: boolean }>('POST', `/agent-sessions/${id}/resize`, { cols, rows }),
  /** URL for the live server-sent-events output stream of a session. */
  sessionStreamUrl: (id: number, after: number) =>
    `/api/agent-sessions/${id}/stream?after=${after}`,
  startSession: (id: number) => request<AgentSession>('POST', `/agent-sessions/${id}/start`),
  stopSession: (id: number) => request<AgentSession>('POST', `/agent-sessions/${id}/stop`),
  deleteSession: (id: number) => request<void>('DELETE', `/agent-sessions/${id}`),

  listRuns: (projectId: number, cardId?: number) =>
    request<AgentRun[]>(
      'GET',
      `/projects/${projectId}/agent-runs${cardId !== undefined ? `?cardId=${cardId}` : ''}`,
    ),
  runSummaries: (projectId: number) =>
    request<CardRunSummary[]>('GET', `/projects/${projectId}/agent-runs/summary`),
  dispatchCard: (
    projectId: number,
    cardId: number,
    input: {
      providerId?: string;
      command?: string[];
      prompt?: string;
      timeoutMin?: number;
      maxAttempts?: number;
      autonomy?: AgentAutonomy;
    },
  ) => request<AgentRun>('POST', `/projects/${projectId}/cards/${cardId}/dispatch`, input),
  runOutput: (id: number, after: number) =>
    request<AgentOutput>('GET', `/agent-runs/${id}/output?after=${after}`),
  stopRun: (id: number) => request<AgentRun>('POST', `/agent-runs/${id}/stop`),
  retryRun: (id: number) => request<AgentRun>('POST', `/agent-runs/${id}/retry`),
  validateRun: (id: number, decision: 'accepted' | 'rejected', moveTo?: 'review' | 'done') =>
    request<AgentRun>('POST', `/agent-runs/${id}/validate`, { decision, moveTo }),
  deleteRun: (id: number) => request<void>('DELETE', `/agent-runs/${id}`),
};
