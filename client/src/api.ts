import type { AntigravityAccountsState } from '../../shared/antigravityAccounts';
import type {
  OrchestratorOverview,
  OrchestratorChatWork,
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
  RemoteConfig,
  RemoteStatus,
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
  CodexAccountsState,
  DirectoryListing,
  ProjectDetail,
  PullRequestAction,
  PullRequestActionResult,
  PullRequestListState,
  PullRequestsResult,
  ProjectSummary,
  ShortcutOverrides,
  WorkspaceLayout,
} from '../../shared/types';
import type { ProviderLimits } from '../../shared/limits';
import { handleSignedOut } from './remote';

const pendingReads = new Map<string, Promise<unknown>>();

/** Share only in-flight reads. Completed results and failures are never cached. */
function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  if (method !== 'GET') return performRequest<T>(method, url, body);
  const pending = pendingReads.get(url);
  if (pending) return pending as Promise<T>;
  const next = performRequest<T>(method, url, body).finally(() => {
    if (pendingReads.get(url) === next) pendingReads.delete(url);
  });
  pendingReads.set(url, next);
  return next;
}

async function performRequest<T>(method: string, url: string, body?: unknown): Promise<T> {
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
  if (res.status === 204) return undefined as T;
  if (method !== 'GET' || !STABLE_READS.test(url)) return (await res.json()) as T;
  // Polled lists: an unchanged answer returns the previous object, so setState bails out and the
  // tree below is not re-rendered every few seconds for nothing.
  const text = await res.text();
  const seen = lastReads.get(url);
  if (seen?.text === text) return seen.value as T;
  const value = JSON.parse(text) as T;
  lastReads.set(url, { text, value });
  return value;
}

const STABLE_READS =
  /^\/(projects|cards|cards\/in-flight|agent-sessions|agent-runs|projects\/\d+\/(cards|agent-sessions))$/;
const lastReads = new Map<string, { text: string; value: unknown }>();

export interface OrchestratorRunPage {
  liveAssignments?: { id: number; projectId: number; cardId: number | null }[];
  version: 1;
  generatedAt: string;
  runs: AgentRun[];
  historyIds?: number[];
  focusFound?: boolean;
  nextBefore: number | null;
  summary?: {
    total: number;
    live: number;
    awaitingReview: number;
    failedReview: number;
    ownedLive: number;
    ownedReview: number;
  };
}

export const api = {
  orchestratorHistory: (id: string, before?: number, focus?: number) =>
    request<OrchestratorRunPage>(
      'GET',
      `/orchestrators/${encodeURIComponent(id)}/history-runs?limit=20${before === undefined ? '' : `&before=${before}`}${focus === undefined ? '' : `&focus=${focus}`}`,
    ),
  orchestratorActionable: (id: string, before: number | undefined, kind: 'live' | 'review') =>
    request<OrchestratorRunPage>(
      'GET',
      `/orchestrators/${encodeURIComponent(id)}/actionable-runs?limit=20&kind=${kind}${before === undefined ? '' : `&before=${before}`}`,
    ),

  orchestratorRuns: (id: string, before?: number, focus?: number) =>
    request<{
      version: 1;
      generatedAt: string;
      runs: AgentRun[];
      historyIds: number[];
      focusFound?: boolean;
      nextBefore: number | null;
    }>(
      'GET',
      `/orchestrators/${encodeURIComponent(id)}/runs?limit=20${before === undefined ? '' : `&before=${before}`}${focus === undefined ? '' : `&focus=${focus}`}`,
    ),
  orchestratorPending: (id: string, offset = 0, projectId?: number) =>
    request<OrchestratorPendingPage>(
      'GET',
      `/orchestrators/${encodeURIComponent(id)}/pending?offset=${offset}&limit=10${projectId ? `&projectId=${projectId}` : ''}`,
    ),

  orchestratorSituation: (id: string) =>
    request<OrchestratorSituation>('GET', `/orchestrators/${encodeURIComponent(id)}/situation`),
  orchestrators: () => request<OrchestratorState>('GET', '/orchestrators'),
  orchestratorOverview: () => request<OrchestratorOverview>('GET', '/orchestrators/overview'),
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
  openOrchestratorChat: (id: string, providerId?: string) =>
    request<AgentSession>('POST', `/orchestrators/${encodeURIComponent(id)}/chat`, { providerId }),
  /** Asks the master's chat for a one-time check on pending work (starting it if needed). */
  getOrchestratorChatWork: (id: string) =>
    request<OrchestratorChatWork | null>(
      'GET',
      `/orchestrators/${encodeURIComponent(id)}/chat-work`,
    ),
  orchestratorChatState: (id: string) =>
    request<{ running: boolean; state: 'running' | 'idle' | 'input' | null }>(
      'GET',
      `/orchestrators/${encodeURIComponent(id)}/chat-state`,
    ),
  /** Messages one in-scope card to the orchestrator's running chat; never starts the chat. */
  sendCardToOrchestratorChat: (id: string, cardId: number) =>
    request<AgentSession>('POST', `/orchestrators/${encodeURIComponent(id)}/send-card`, { cardId }),
  checkOrchestrator: (
    id: string,
    focus: 'all' | 'todo' | 'in_progress' | 'review' | 'attention',
    attentionKinds?: string[],
  ) =>
    request<AgentSession>(
      'POST',
      `/orchestrators/${encodeURIComponent(id)}/check`,
      attentionKinds ? { focus, attentionKinds } : { focus },
    ),
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
  /** The commit author agents use in this project (both null: whatever git is configured with). */
  getGitIdentity: (id: number) =>
    request<{ name: string | null; email: string | null }>('GET', `/projects/${id}/git-identity`),
  setGitIdentity: (id: number, name: string | null, email: string | null) =>
    request<{ name: string | null; email: string | null }>('PUT', `/projects/${id}/git-identity`, {
      name,
      email,
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
  ) =>
    // projectId 0 makes an "All projects" card that belongs to no project (PM-138).
    request<Card>('POST', projectId > 0 ? `/projects/${projectId}/cards` : '/cards', input),
  updateCard: (
    id: number,
    patch: Partial<
      Pick<Card, 'title' | 'description' | 'status' | 'position' | 'issueUrl' | 'projectId'>
    >,
  ) => request<Card>('PATCH', `/cards/${id}`, patch),
  deleteCard: (id: number) => request<void>('DELETE', `/cards/${id}`),

  /** Opt-in LAN access (Settings); only answers on this computer. */
  lanStatus: () => request<LanStatus>('GET', '/lan'),
  setLan: (enabled: boolean) => request<LanStatus>('PUT', '/lan', { enabled }),
  lanNewCode: () => request<LanStatus>('POST', '/lan/new-code', {}),
  /** Signs one LAN device out, or every device without an id. */
  lanSignOut: (deviceId?: string) =>
    request<LanStatus>('DELETE', deviceId ? `/lan/devices/${deviceId}` : '/lan/devices'),
  /** Opt-in remote access through a Cloudflare Tunnel (Settings); only answers on this computer. */
  remoteStatus: () => request<RemoteStatus>('GET', '/remote'),
  remoteConfigure: (config: RemoteConfig) => request<RemoteStatus>('PUT', '/remote/config', config),
  remoteBeginTotp: () => request<RemoteStatus>('POST', '/remote/totp', {}),
  remoteConfirmTotp: (code: string) =>
    request<RemoteStatus>('POST', '/remote/totp/confirm', { code }),
  setRemote: (enabled: boolean) => request<RemoteStatus>('PUT', '/remote', { enabled }),
  remoteSignOut: (sessionId?: string) =>
    request<RemoteStatus>(
      'DELETE',
      sessionId ? `/remote/sessions/${sessionId}` : '/remote/sessions',
    ),
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
  /** Keyboard shortcuts changed from their defaults (PM-244). */
  getShortcuts: () => request<{ overrides: ShortcutOverrides }>('GET', '/preferences/shortcuts'),
  saveShortcuts: (overrides: ShortcutOverrides) =>
    request<{ overrides: ShortcutOverrides }>('PUT', '/preferences/shortcuts', { overrides }),
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
  /** "Try again" after a usage limit (PM-58): sends the continuation once, now. */
  continueSessionNow: (id: number) =>
    request<AgentSession>('POST', `/agent-sessions/${id}/continue-now`),
  /** Switch a Codex session's account (PM-164) and optionally continue immediately. */
  switchSessionCodexAccount: (id: number, profileId: string | null, continuePrompt?: boolean) =>
    request<AgentSession>('POST', `/agent-sessions/${id}/codex-account`, {
      profileId,
      continuePrompt,
    }),
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
  resolveUnknownRun: (id: number, nonce: string) =>
    request<AgentRun>('POST', `/agent-runs/${id}/resolve-unknown`, {
      nonce,
      confirmation: 'worker-stopped',
    }),
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

  // ---- Codex accounts (PM-164) ------------------------------------------------------------------
  getAntigravityAccounts: () =>
    request<AntigravityAccountsState>('GET', '/agents/antigravity-accounts'),
  refreshAntigravityAccounts: () =>
    request<AntigravityAccountsState>('POST', '/agents/antigravity-accounts/usage'),
  switchAntigravityAccount: (accountId: string) =>
    request<AntigravityAccountsState>('PUT', '/agents/antigravity-accounts/active', { accountId }),
  refreshCodexAccountsUsage: () =>
    request<CodexAccountsState>('POST', '/agents/codex-accounts/usage'),
  getCodexAccounts: () => request<CodexAccountsState>('GET', '/agents/codex-accounts'),
  /** The accounts panel: also starts a background re-read of missing or old usage (PM-173). */
  getCodexAccountsRefreshing: () =>
    request<CodexAccountsState>('GET', '/agents/codex-accounts?refresh=stale'),
  importCodexAccount: (name: string, authJson: string) =>
    request<CodexAccountsState>('POST', '/agents/codex-accounts', { name, authJson }),
  saveCurrentCodexAccount: (name?: string) =>
    request<CodexAccountsState>('POST', '/agents/codex-accounts', {
      saveCurrent: true,
      ...(name ? { name } : {}),
    }),
  setActiveCodexAccount: (activeProfileId: string | null) =>
    request<CodexAccountsState>('PUT', '/agents/codex-accounts/active', { activeProfileId }),
  setCodexAccountAutoSwitchEligible: (accountId: string, eligible: boolean) =>
    request<CodexAccountsState>(
      'PUT',
      `/agents/codex-accounts/${encodeURIComponent(accountId)}/auto-switch`,
      { eligible },
    ),
  setCodexAutoSwitch: (autoSwitch: boolean) =>
    request<CodexAccountsState>('PUT', '/agents/codex-accounts/auto-switch', { autoSwitch }),
  renameCodexAccount: (accountId: string, name: string) =>
    request<CodexAccountsState>(
      'PATCH',
      `/agents/codex-accounts/${encodeURIComponent(accountId)}`,
      {
        name,
      },
    ),
  removeCodexAccount: (accountId: string) =>
    request<CodexAccountsState>(
      'DELETE',
      `/agents/codex-accounts/${encodeURIComponent(accountId)}`,
    ),
  getClaudeAccounts: () => request<CodexAccountsState>('GET', '/agents/claude-accounts'),
  importClaudeAccount: (name: string, authJson: string) =>
    request<CodexAccountsState>('POST', '/agents/claude-accounts', { name, authJson }),
  saveCurrentClaudeAccount: (name?: string) =>
    request<CodexAccountsState>('POST', '/agents/claude-accounts', {
      saveCurrent: true,
      ...(name ? { name } : {}),
    }),
  setActiveClaudeAccount: (activeProfileId: string | null) =>
    request<CodexAccountsState>('PUT', '/agents/claude-accounts/active', { activeProfileId }),
  setClaudeAutoSwitch: (autoSwitch: boolean) =>
    request<CodexAccountsState>('PUT', '/agents/claude-accounts/auto-switch', { autoSwitch }),
  renameClaudeAccount: (accountId: string, name: string) =>
    request<CodexAccountsState>(
      'PATCH',
      `/agents/claude-accounts/${encodeURIComponent(accountId)}`,
      { name },
    ),
  removeClaudeAccount: (accountId: string) =>
    request<CodexAccountsState>(
      'DELETE',
      `/agents/claude-accounts/${encodeURIComponent(accountId)}`,
    ),
};
