import type {
  AgentAutonomy,
  AgentInstall,
  AgentOutput,
  AgentPermissions,
  LanStatus,
  AgentProviderStatus,
  AgentTerminal,
  AgentRun,
  AgentSession,
  AgentTokenUsage,
  CardAttachment,
  BoardPreset,
  BulkAddResult,
  Card,
  CardRunSummary,
  CardStatus,
  CardWithProject,
  DirectoryListing,
  ProjectDetail,
  PullRequestsResult,
  ProjectSummary,
  WorkspaceLayout,
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
  pullRequests: (id: number) => request<PullRequestsResult>('GET', `/projects/${id}/pull-requests`),
  listProjects: () => request<ProjectSummary[]>('GET', '/projects'),
  getProject: (id: number) => request<ProjectDetail>('GET', `/projects/${id}`),
  addProject: (path: string, name?: string) =>
    request<ProjectDetail>('POST', '/projects', { path, name }),
  addProjects: (paths: string[]) => request<BulkAddResult>('POST', '/projects/batch', { paths }),
  renameProject: (id: number, name: string) =>
    request<ProjectDetail>('PATCH', `/projects/${id}`, { name }),
  setBoardPreset: (id: number, boardPreset: BoardPreset) =>
    request<ProjectDetail>('PATCH', `/projects/${id}`, { boardPreset }),
  removeProject: (id: number) => request<void>('DELETE', `/projects/${id}`),
  scanProject: (id: number) => request<ProjectDetail>('POST', `/projects/${id}/scan`),
  /** Opens the project folder in Explorer / Finder / the desktop file manager. */
  openProjectFolder: (id: number) => request<void>('POST', `/projects/${id}/open-folder`, {}),

  /** Every card across projects (the global board). */
  cardAgentAudit: (id: number) =>
    request<
      { owner_kind: string; owner_id: number; action: string; detail: string; created_at: string }[]
    >('GET', `/cards/${id}/agent-audit`),
  listAllCards: () => request<CardWithProject[]>('GET', '/cards'),
  listCardsInFlight: () => request<CardWithProject[]>('GET', '/cards/in-flight'),
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

  /** Opt-in LAN access (Settings); only answers on this computer. */
  lanStatus: () => request<LanStatus>('GET', '/lan'),
  setLan: (enabled: boolean) => request<LanStatus>('PUT', '/lan', { enabled }),
  lanNewCode: () => request<LanStatus>('POST', '/lan/new-code', {}),
  /** Signs one LAN device out, or every device without an id. */
  lanSignOut: (deviceId?: string) =>
    request<LanStatus>('DELETE', deviceId ? `/lan/devices/${deviceId}` : '/lan/devices'),
  /** Global agent permissions and per-CLI overrides (Settings). */
  getPermissions: () => request<AgentPermissions>('GET', '/agents/permissions'),
  savePermissions: (value: AgentPermissions) =>
    request<AgentPermissions>('PUT', '/agents/permissions', value),
  /** The colour theme, stored server-side so it survives restarts and port changes. */
  getTheme: () =>
    request<{ theme: 'system' | 'light' | 'dark' | null }>('GET', '/preferences/theme'),
  saveTheme: (theme: 'system' | 'light' | 'dark') =>
    request<{ theme: string }>('PUT', '/preferences/theme', { theme }),
  browse: (path?: string) =>
    request<DirectoryListing>(
      'GET',
      `/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`,
    ),

  // ---- Card images ----------------------------------------------------------------------------
  listAttachments: (cardId: number) =>
    request<CardAttachment[]>('GET', `/cards/${cardId}/attachments`),
  /** `data` is base64 (the API only accepts JSON writes). */
  addAttachment: (cardId: number, image: { name: string; type: string; data: string }) =>
    request<CardAttachment>('POST', `/cards/${cardId}/attachments`, image),
  deleteAttachment: (cardId: number, file: string) =>
    request<void>('DELETE', `/cards/${cardId}/attachments/${encodeURIComponent(file)}`),

  // ---- Agent CLI sessions and runs ------------------------------------------------------------
  listProviders: () => request<AgentProviderStatus[]>('GET', '/agents/providers'),
  listAllSessions: () => request<AgentSession[]>('GET', '/agent-sessions'),
  /** Token usage per session id (null where the CLI doesn't expose it). */
  sessionUsage: (ids: number[]) =>
    request<Record<number, AgentTokenUsage | null>>(
      'GET',
      `/agent-sessions/usage?ids=${ids.join(',')}`,
    ),
  getWorkspace: () => request<WorkspaceLayout>('GET', '/workspace'),
  saveWorkspace: (layout: WorkspaceLayout) => request<WorkspaceLayout>('PUT', '/workspace', layout),
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
      cardId?: number;
      prompt?: string;
    },
  ) => request<AgentSession>('POST', `/projects/${projectId}/agent-sessions`, input),
  patchSession: (id: number, patch: { name?: string; supervise?: boolean }) =>
    request<AgentSession>('PATCH', `/agent-sessions/${id}`, patch),
  /** Make a card the session's current task; `send` pastes the task into an AI CLI session. */
  attachCardToSession: (id: number, cardId: number | null, send = false, prompt?: string) =>
    request<{ session: AgentSession; queued: boolean; sent: boolean }>(
      'POST',
      `/agent-sessions/${id}/card`,
      { cardId, send, prompt },
    ),
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

  /** Newest runs across every project. */
  listAllRuns: () => request<AgentRun[]>('GET', '/agent-runs'),
  renameRun: (id: number, name: string) =>
    request<AgentRun>('PATCH', `/agent-runs/${id}`, { name }),
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

  // ---- Agent CLI installs (Settings) ------------------------------------------------------------
  listProvidersRefresh: () => request<AgentProviderStatus[]>('GET', '/agents/providers?refresh=1'),
  installProvider: (providerId: string) =>
    request<AgentInstall>('POST', `/agents/providers/${providerId}/install`),
  listInstalls: () => request<AgentInstall[]>('GET', '/agent-installs'),
  installOutput: (id: number, after: number) =>
    request<AgentOutput>('GET', `/agent-installs/${id}/output?after=${after}`),
  deleteInstall: (id: number) => request<void>('DELETE', `/agent-installs/${id}`),
};
