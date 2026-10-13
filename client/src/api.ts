import type {
  OrchestratorConfig,
  OrchestratorSituation,
  OrchestratorPendingPage,
  OrchestratorPlanDecision,
  OrchestratorState,
} from '../../shared/orchestrator';
import type {
  AgentAutonomy,
  ChatItem,
  AgentInstall,
  AgentOutput,
  AgentPermissions,
  CpuBudget,
  MachineSensors,
  SessionTranscript,
  SlashCommand,
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
  PullRequestAction,
  PullRequestActionResult,
  PullRequestListState,
  PullRequestsResult,
  ProjectSummary,
  WorkspaceLayout,
} from '../../shared/types';
import type { ProviderLimits } from '../../shared/limits';
import { handleSignedOut } from './remote';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    // Always JSON: the server rejects non-JSON writes as a CSRF guard.
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    if (res.status === 401) handleSignedOut();
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  orchestratorRuns: (id: string, before?: number) =>
    request<{
      version: 1;
      generatedAt: string;
      runs: AgentRun[];
      historyIds: number[];
      nextBefore: number | null;
    }>(
      'GET',
      `/orchestrators/${encodeURIComponent(id)}/runs?limit=20${before === undefined ? '' : `&before=${before}`}`,
    ),
  orchestratorPending: (id: string, offset = 0, projectId?: number) =>
    request<OrchestratorPendingPage>(
      'GET',
      `/orchestrators/${encodeURIComponent(id)}/pending?offset=${offset}&limit=10${projectId ? `&projectId=${projectId}` : ''}`,
    ),

  orchestratorSituation: (id: string) =>
    request<OrchestratorSituation>('GET', `/orchestrators/${encodeURIComponent(id)}/situation`),
  orchestrators: () => request<OrchestratorState>('GET', '/orchestrators'),
  previewOrchestrator: (id: string, offset = 0) =>
    request<{
      at: string;
      enabled: boolean;
      strategy: string;
      decisions: OrchestratorPlanDecision[];
      total?: number;
      offset?: number;
      limit?: number;
      summary?: { dispatch: number; review: number; wait: number };
    }>('GET', `/orchestrators/${encodeURIComponent(id)}/preview?offset=${offset}&limit=100`),
  saveOrchestrator: (config: Omit<OrchestratorConfig, 'id'> & { id?: string }) =>
    request<OrchestratorConfig>('POST', '/orchestrators', config),
  tickOrchestrators: (id?: string) =>
    request<OrchestratorState>(
      'POST',
      id ? `/orchestrators/${encodeURIComponent(id)}/tick` : '/orchestrators/tick',
    ),
  clearOrchestratorEvents: () => request<OrchestratorState>('DELETE', '/orchestrators/events'),
  deleteOrchestrator: (id: string) => request<OrchestratorState>('DELETE', `/orchestrators/${id}`),
  /** The master's own chat CLI (PM-89): opens or reopens it. */
  openOrchestratorChat: (id: string) =>
    request<AgentSession>('POST', `/orchestrators/${encodeURIComponent(id)}/chat`, {}),
  /** Asks the master's chat for a one-time check on pending work (starting it if needed). */
  checkOrchestrator: (id: string, focus: 'all' | 'todo' | 'in_progress' | 'review') =>
    request<AgentSession>('POST', `/orchestrators/${encodeURIComponent(id)}/check`, { focus }),
  pruneOrchestratorAttention: (id?: string, projectId?: number) =>
    request<{ ok: boolean; state: OrchestratorState }>(
      'POST',
      id
        ? `/orchestrators/${encodeURIComponent(id)}/prune-attention`
        : '/orchestrators/prune-attention',
      projectId ? { projectId } : undefined,
    ),
  resolveOrchestratorAttention: (id?: string, projectId?: number) =>
    request<{
      ok: boolean;
      state: OrchestratorState;
      result: { resolvedCards: number[]; dispatchedRuns: number[] };
    }>(
      'POST',
      id
        ? `/orchestrators/${encodeURIComponent(id)}/resolve-attention`
        : '/orchestrators/resolve-attention',
      projectId ? { projectId } : undefined,
    ),
  dismissOrchestratorAttention: (projectId: number, kinds?: string[]) =>
    request<{ ok: boolean; state: OrchestratorState }>('POST', '/orchestrators/dismiss-attention', {
      projectId,
      kinds,
    }),
  agentLimits: () => request<ProviderLimits[]>('GET', '/agent-limits'),
  pullRequests: (id: number, state: PullRequestListState = 'open') =>
    request<PullRequestsResult>('GET', `/projects/${id}/pull-requests?state=${state}`),
  pullRequestAction: (id: number, number: number, action: PullRequestAction) =>
    request<PullRequestActionResult>(
      'POST',
      `/projects/${id}/pull-requests/${number}/actions`,
      action,
    ),
  /** Chooses the gh account for a project's pull requests (null: automatic, the repo owner). */
  setPullRequestAccount: (id: number, account: string | null) =>
    request<{ override: string | null }>('PUT', `/projects/${id}/pull-requests/account`, {
      account,
    }),
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
    input: { title: string; description?: string; status: CardStatus; issueUrl?: string | null },
  ) => request<Card>('POST', `/projects/${projectId}/cards`, input),
  updateCard: (
    id: number,
    patch: Partial<Pick<Card, 'title' | 'description' | 'status' | 'position' | 'issueUrl'>>,
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
  getCpuBudget: () => request<CpuBudget>('GET', '/agents/cpu-budget'),
  setCpuBudget: (threads: number) => request<CpuBudget>('PUT', '/agents/cpu-budget', { threads }),
  getSensors: () => request<MachineSensors>('GET', '/agents/sensors'),
  getPermissions: () => request<AgentPermissions>('GET', '/agents/permissions'),
  savePermissions: (value: AgentPermissions) =>
    request<AgentPermissions>('PUT', '/agents/permissions', value),
  /** The colour theme, stored server-side so it survives restarts and port changes. */
  getTheme: () =>
    request<{ theme: 'system' | 'light' | 'dark' | null }>('GET', '/preferences/theme'),
  saveTheme: (theme: 'system' | 'light' | 'dark') =>
    request<{ theme: string }>('PUT', '/preferences/theme', { theme }),
  getProjectOrder: () => request<{ order: number[] }>('GET', '/preferences/project-order'),
  saveProjectOrder: (order: number[]) =>
    request<{ order: number[] }>('PUT', '/preferences/project-order', { order }),
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
  /** Saves an image for a session (PM-54); returns its absolute path to paste into the CLI. */
  uploadSessionImage: (id: number, image: { name: string; type: string; data: string }) =>
    request<{ path: string }>('POST', `/agent-sessions/${id}/images`, image),
  /** Chat view (mobile): the CLI's transcript from `after` (a previous `next`), or its tail. */
  sessionTranscript: (id: number, after?: number) =>
    request<SessionTranscript>(
      'GET',
      `/agent-sessions/${id}/transcript${after === undefined ? '' : `?after=${after}`}`,
    ),
  sessionScreen: (id: number) => request<{ text: string }>('GET', `/agent-sessions/${id}/screen`),
  /** A Claude subagent's own steps, for the tool call that started it; null when none kept. */
  sessionSubagent: (id: number, toolId: string) =>
    request<{ items: ChatItem[] | null }>(
      'GET',
      `/agent-sessions/${id}/subagent?tool=${encodeURIComponent(toolId)}`,
    ),
  /** Chat view suggestions (PM-117): the CLI's slash commands, and files matching an @-mention. */
  sessionCommands: (id: number) => request<SlashCommand[]>('GET', `/agent-sessions/${id}/commands`),
  sessionFiles: (id: number, q: string) =>
    request<string[]>('GET', `/agent-sessions/${id}/files?q=${encodeURIComponent(q)}`),
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
  restartSession: (id: number) => request<AgentSession>('POST', `/agent-sessions/${id}/restart`),
  setAutoContinue: (id: number, enabled: boolean) =>
    request<AgentSession>('POST', `/agent-sessions/${id}/auto-continue`, { enabled }),
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
