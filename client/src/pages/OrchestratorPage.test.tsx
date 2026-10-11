// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { api } from '../api';
import { OrchestratorPage } from './OrchestratorPage';
vi.mock('../api', () => ({
  api: {
    orchestrators: vi.fn(async () => ({ instances: [], events: [] })),
    listProjects: vi.fn(async () => [{ id: 1, name: 'Project one' }]),
    saveOrchestrator: vi.fn(async () => ({})),
    tickOrchestrators: vi.fn(),
    clearOrchestratorEvents: vi.fn(async () => ({ instances: [], events: [] })),
    deleteOrchestrator: vi.fn(async () => ({ instances: [], events: [] })),
    pruneOrchestratorAttention: vi.fn(async () => ({
      ok: true,
      state: { instances: [], events: [] },
    })),
    resolveOrchestratorAttention: vi.fn(async () => ({
      ok: true,
      state: { instances: [], events: [] },
      result: { resolvedCards: [], dispatchedRuns: [] },
    })),
    dismissOrchestratorAttention: vi.fn(async () => ({
      ok: true,
      state: { instances: [], events: [] },
    })),
    listAllRuns: vi.fn(async () => []),
    listAllSessions: vi.fn(async () => []),
    listCardsInFlight: vi.fn(async () => []),
    previewOrchestrator: vi.fn(),
  },
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('ignores a background state response that predates a completed save', async () => {
  let release!: () => void;
  vi.mocked(api.orchestrators).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            instances: [],
            events: [
              {
                at: new Date().toISOString(),
                orchestratorId: 'old',
                action: 'wait',
                message: 'Stale poll result',
              },
            ],
          });
      }),
  );
  render(
    <MemoryRouter>
      <OrchestratorPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fresh save' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save orchestrator' }));
  await waitFor(() => expect(api.orchestrators).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save orchestrator' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  await act(async () => {
    release();
  });
  expect(screen.queryByText('Stale poll result')).toBeNull();
});
it('creates a paused master with the chosen scope and quota policy', async () => {
  render(
    <MemoryRouter>
      <OrchestratorPage />
    </MemoryRouter>,
  );
  await screen.findByText('Create a master to coordinate board work across your projects.');
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Project master' } });
  fireEvent.click(screen.getByRole('button', { name: 'Project scope' }));
  fireEvent.click(screen.getByRole('button', { name: 'Project one' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save orchestrator' }));
  await waitFor(() =>
    expect(api.saveOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Project master',
        enabled: false,
        projectIds: [1],
        allowUnknownQuota: false,
      }),
    ),
  );
});
it('shows save errors without losing the draft', async () => {
  vi.mocked(api.saveOrchestrator).mockRejectedValueOnce(new Error('Server unavailable'));
  render(
    <MemoryRouter>
      <OrchestratorPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Keep this master' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save orchestrator' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Server unavailable');
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Keep this master');
});

it('renders pruned decision history with filters and clear history support', async () => {
  vi.mocked(api.orchestrators).mockResolvedValueOnce({
    instances: [
      {
        id: 'm1',
        name: 'Master',
        enabled: true,
        projectIds: [],
        providers: ['codex'],
        maxWorkers: 2,
        maxWorkersPerProject: 1,
        maxWorkersPerProvider: 1,
        reservePercent: 10,
        allowUnknownQuota: false,
        quotaMaxAgeMs: 60000,
      },
    ],
    events: [
      {
        at: '2026-10-10T14:00:00.000Z',
        orchestratorId: 'm1',
        cardId: 10,
        action: 'wait',
        message: 'Already assigned to a live worker',
        count: 5,
      },
      {
        at: '2026-10-10T14:05:00.000Z',
        orchestratorId: 'm1',
        cardId: 12,
        runId: 4,
        action: 'dispatched',
        message: 'Worker 4 started with codex',
      },
    ],
  });

  render(
    <MemoryRouter>
      <OrchestratorPage />
    </MemoryRouter>,
  );

  await screen.findByText('Decision history');
  expect(screen.getByText('PM-10')).toBeDefined();
  expect(screen.getByText('PM-12')).toBeDefined();
  expect(screen.getByText('5×')).toBeDefined();
  expect(screen.getByText('Worker 4 started with codex')).toBeDefined();

  // Filter to Dispatched only
  fireEvent.click(screen.getByRole('button', { name: /Dispatched/ }));
  expect(screen.queryByText('Already assigned to a live worker')).toBeNull();
  expect(screen.getByText('Worker 4 started with codex')).toBeDefined();

  // Clear history
  fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
  await waitFor(() => expect(api.clearOrchestratorEvents).toHaveBeenCalled());
});

it('renders masters dashboard with pills, collapses form, supports edit and delete', async () => {
  const master = {
    id: 'm1',
    name: 'Primary Orchestrator',
    enabled: true,
    projectIds: [1],
    providers: ['codex', 'claude'],
    maxWorkers: 6,
    maxWorkersPerProject: 2,
    maxWorkersPerProvider: 3,
    reservePercent: 15,
    allowUnknownQuota: true,
    followDashboardAttention: true,
    quotaMaxAgeMs: 60000,
  };

  vi.mocked(api.orchestrators).mockResolvedValueOnce({
    instances: [master],
    events: [],
  });

  render(
    <MemoryRouter>
      <OrchestratorPage />
    </MemoryRouter>,
  );

  // Masters dashboard rendered
  expect(await screen.findByRole('heading', { name: 'Primary Orchestrator' })).toBeDefined();
  expect(screen.getByText('Active')).toBeDefined();
  expect(screen.getAllByText(/Project one/)[0]).toBeDefined();
  expect(screen.getByText(/Codex, Claude/)).toBeDefined();
  expect(screen.getByText(/Up to 6 workers/)).toBeDefined();
  expect(screen.getByText(/15% reserve/)).toBeDefined();
  expect(screen.getByText(/Attention follow-up/)).toBeDefined();
  expect(screen.getByText(/Unknown quota allowed/)).toBeDefined();

  // Form should NOT be visible initially when masters exist
  expect(screen.queryByLabelText('Name')).toBeNull();

  // Click "+ New master" opens the form
  fireEvent.click(screen.getByRole('button', { name: '+ New master' }));
  expect(screen.getByLabelText('Name')).toBeDefined();
  expect(screen.getByText('New orchestrator')).toBeDefined();

  // Cancel edit closes the form
  fireEvent.click(screen.getAllByRole('button', { name: 'Cancel edit' })[0]!);
  expect(screen.queryByLabelText('Name')).toBeNull();

  // Click "Edit" on the master opens the form prefilled
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByLabelText('Name')).toBeDefined();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Primary Orchestrator');

  // Cancel again
  fireEvent.click(screen.getAllByRole('button', { name: 'Cancel edit' })[0]!);

  // Delete master with ConfirmDelete
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete master' }));
  await waitFor(() => expect(api.deleteOrchestrator).toHaveBeenCalledWith('m1'));
});

it('renders scope board progress summary and live workers with direct links', async () => {
  const master = {
    id: 'm1',
    name: 'Frontend Master',
    enabled: true,
    projectIds: [1],
    providers: ['codex', 'claude'],
    maxWorkers: 4,
    maxWorkersPerProject: 2,
    maxWorkersPerProvider: 2,
    reservePercent: 10,
    allowUnknownQuota: false,
    quotaMaxAgeMs: 60000,
  };

  vi.mocked(api.orchestrators).mockResolvedValueOnce({
    instances: [master],
    events: [],
  });
  vi.mocked(api.listProjects).mockResolvedValueOnce([
    {
      id: 1,
      name: 'Project one',
      path: '/proj1',
      createdAt: '2026-01-01',
      lastScannedAt: null,
      missing: false,
      scan: { status: 'idle', error: null, startedAt: null, moves: [] },
      code: null,
      disk: null,
      git: null,
      boardPreset: 'full',
      runningSessions: 1,
      cardCounts: { todo: 3, in_progress: 2, review: 1, done: 5, backlog: 0 },
    },
  ]);
  vi.mocked(api.listAllRuns).mockResolvedValueOnce([
    {
      id: 101,
      projectId: 1,
      cardId: 42,
      cardKey: 'PM-42',
      name: 'Build feature',
      providerId: 'codex',
      command: ['codex'],
      prompt: 'do work',
      autonomy: 'full',
      changes: null,
      status: 'running',
      exitCode: null,
      error: null,
      attempts: 1,
      maxAttempts: 1,
      validation: null,
      validatedAt: null,
      validatedMove: null,
      createdAt: '2026-10-10T12:00:00Z',
      startedAt: '2026-10-10T12:00:00Z',
      endedAt: null,
      logBytes: 100,
    },
  ]);
  vi.mocked(api.listAllSessions).mockResolvedValueOnce([
    {
      id: 202,
      projectId: 1,
      name: 'Claude Terminal',
      providerId: 'claude',
      command: ['claude'],
      cwd: '/proj1',
      terminal: 'pty',
      cardId: null,
      cardKey: null,
      pid: 1234,
      status: 'running',
      exitCode: null,
      desiredState: 'running',
      supervise: true,
      resumeSupported: true,
      restarts: 0,
      lastRestartAt: null,
      queuedInputBytes: 0,
      createdAt: '2026-10-10T12:00:00Z',
      startedAt: '2026-10-10T12:00:00Z',
      endedAt: null,
      logBytes: 200,
      lastOutputAt: null,
      tailState: 'running',
    },
  ]);

  render(
    <MemoryRouter>
      <OrchestratorPage />
    </MemoryRouter>,
  );

  // Scope board progress summary
  expect(await screen.findByText('Scope Board Progress')).toBeDefined();
  expect(screen.getByText('View board →')).toBeDefined();
  expect(screen.getByText('To do')).toBeDefined();
  expect(screen.getByText('3')).toBeDefined();
  expect(screen.getByText('In progress')).toBeDefined();
  expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText('Review')).toBeDefined();
  expect(screen.getAllByText('1').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText('Done')).toBeDefined();
  expect(screen.getByText('5')).toBeDefined();

  // Being worked on
  expect(screen.getByText('Being worked on')).toBeDefined();
  expect(screen.getByText('2 active')).toBeDefined();
  expect(screen.getByText('Build feature')).toBeDefined();
  expect(screen.getByText('PM-42')).toBeDefined();
  expect(screen.getByText('Claude Terminal')).toBeDefined();
  expect(screen.getByText('Terminal →')).toBeDefined();
  expect(screen.getByText('Workspace →')).toBeDefined();
});

it('renders Needs Attention queue and allows resolving or pruning attention', async () => {
  const master = {
    id: 'm1',
    name: 'Frontend Master',
    enabled: true,
    projectIds: [1],
    providers: ['codex'],
    maxWorkers: 2,
    maxWorkersPerProject: 2,
    maxWorkersPerProvider: 2,
    reservePercent: 10,
    allowUnknownQuota: false,
    quotaMaxAgeMs: 60000,
    pruneDashboardAttention: true,
  };

  vi.mocked(api.orchestrators).mockResolvedValue({
    instances: [master],
    events: [],
  });
  vi.mocked(api.pruneOrchestratorAttention).mockResolvedValue({
    ok: true,
    state: { instances: [master], events: [] },
  });
  vi.mocked(api.resolveOrchestratorAttention).mockResolvedValue({
    ok: true,
    state: { instances: [master], events: [] },
    result: { resolvedCards: [42], dispatchedRuns: [10] },
  });
  vi.mocked(api.dismissOrchestratorAttention).mockResolvedValue({
    ok: true,
    state: { instances: [master], events: [] },
  });
  vi.mocked(api.listProjects).mockResolvedValue([
    {
      id: 1,
      name: 'Project one',
      path: '/proj1',
      createdAt: '2026-01-01',
      lastScannedAt: null,
      missing: false,
      scan: { status: 'idle', error: null, startedAt: null, moves: [] },
      code: null,
      disk: null,
      git: {
        isRepo: true,
        branch: 'main',
        dirtyFiles: 3,
        ahead: 0,
        behind: 0,
        totalCommits: 1,
        firstCommitAt: '2026-01-01',
        lastCommitAt: new Date().toISOString(),
        contributors: [],
        dailyCommits: {},
        recentCommits: [],
        remoteUrl: null,
      },
      boardPreset: 'full',
      runningSessions: 0,
      cardCounts: { todo: 0, in_progress: 0, review: 0, done: 0, backlog: 0 },
    },
  ]);
  vi.mocked(api.listAllRuns).mockResolvedValue([]);
  vi.mocked(api.listAllSessions).mockResolvedValue([]);
  vi.mocked(api.listCardsInFlight).mockResolvedValue([]);

  render(
    <MemoryRouter>
      <OrchestratorPage />
    </MemoryRouter>,
  );

  expect(await screen.findByText('Needs Attention')).toBeDefined();
  expect(screen.getByText('1 issue')).toBeDefined();
  expect(screen.getByText('Uncommitted')).toBeDefined();
  expect(screen.getByText('3 changed files')).toBeDefined();

  // Test Resolve attention button
  const resolveAllBtn = screen.getByRole('button', { name: 'Resolve attention' });
  fireEvent.click(resolveAllBtn);
  await waitFor(() => {
    expect(api.resolveOrchestratorAttention).toHaveBeenCalledWith('m1');
  });

  // Test individual Resolve button
  const resolveItemBtn = screen.getByRole('button', { name: 'Resolve' });
  fireEvent.click(resolveItemBtn);
  await waitFor(() => {
    expect(api.resolveOrchestratorAttention).toHaveBeenCalledWith('m1', 1);
  });

  // Test Prune / Dismiss header button
  const pruneAllBtn = screen.getByRole('button', { name: 'Prune / Dismiss' });
  fireEvent.click(pruneAllBtn);
  await waitFor(() => {
    expect(api.pruneOrchestratorAttention).toHaveBeenCalledWith('m1');
  });

  // Test individual Dismiss button
  const dismissItemBtn = screen.getByRole('button', { name: 'Dismiss' });
  fireEvent.click(dismissItemBtn);
  await waitFor(() => {
    expect(api.dismissOrchestratorAttention).toHaveBeenCalledWith(1, ['Uncommitted']);
    expect(api.pruneOrchestratorAttention).toHaveBeenCalledWith('m1', 1);
  });
});

it('displays Being worked on badge for attention items with active workers', async () => {
  const master = {
    id: 'm1',
    name: 'Frontend Master',
    enabled: true,
    projectIds: [1],
    providers: ['codex'],
    maxWorkers: 2,
    maxWorkersPerProject: 2,
    maxWorkersPerProvider: 2,
    reservePercent: 10,
    allowUnknownQuota: false,
    quotaMaxAgeMs: 60000,
    pruneDashboardAttention: true,
  };

  vi.mocked(api.orchestrators).mockResolvedValue({
    instances: [master],
    events: [],
  });
  vi.mocked(api.listProjects).mockResolvedValue([
    {
      id: 1,
      name: 'Project one',
      path: '/proj1',
      createdAt: '2026-01-01',
      lastScannedAt: null,
      missing: false,
      scan: { status: 'idle', error: null, startedAt: null, moves: [] },
      code: null,
      disk: null,
      git: {
        isRepo: true,
        branch: 'main',
        dirtyFiles: 3,
        ahead: 0,
        behind: 0,
        totalCommits: 1,
        firstCommitAt: '2026-01-01',
        lastCommitAt: new Date().toISOString(),
        contributors: [],
        dailyCommits: {},
        recentCommits: [],
        remoteUrl: null,
      },
      boardPreset: 'full',
      runningSessions: 1,
      cardCounts: { todo: 0, in_progress: 1, review: 0, done: 0, backlog: 0 },
    },
  ]);
  vi.mocked(api.listAllRuns).mockResolvedValue([
    {
      id: 55,
      projectId: 1,
      cardId: 99,
      cardKey: 'PM-99',
      name: 'Resolve attention',
      providerId: 'codex',
      command: ['codex'],
      prompt: 'fix',
      autonomy: 'full',
      changes: null,
      status: 'running',
      exitCode: null,
      error: null,
      attempts: 1,
      maxAttempts: 1,
      validation: null,
      validatedAt: null,
      validatedMove: null,
      createdAt: '2026-10-10T12:00:00Z',
      startedAt: '2026-10-10T12:00:00Z',
      endedAt: null,
      logBytes: 100,
    },
  ]);
  vi.mocked(api.listAllSessions).mockResolvedValue([]);
  vi.mocked(api.listCardsInFlight).mockResolvedValue([]);

  render(
    <MemoryRouter>
      <OrchestratorPage />
    </MemoryRouter>,
  );

  expect(await screen.findByText('Needs Attention')).toBeDefined();
  expect(screen.getByText('1 being worked on')).toBeDefined();
  expect(screen.getAllByText('Being worked on').length).toBeGreaterThanOrEqual(1);
});

it('renders Plan Preview with typed wait reasons, occupancy metrics, and shows live checking status', async () => {
  const master = {
    id: 'm1',
    name: 'Scoped Master',
    enabled: true,
    projectIds: [1],
    providers: ['codex', 'claude'],
    maxWorkers: 2,
    maxWorkersPerProject: 1,
    maxWorkersPerProvider: 1,
    reservePercent: 10,
    allowUnknownQuota: false,
    quotaMaxAgeMs: 60000,
  };

  vi.mocked(api.orchestrators).mockResolvedValue({
    instances: [master],
    events: [],
    status: {
      executing: true,
      lastTickAt: '2026-10-10T12:00:00Z',
    },
  });

  vi.mocked(api.previewOrchestrator).mockResolvedValue({
    at: '2026-10-10T12:05:00Z',
    total: 201,
    offset: 0,
    limit: 100,
    summary: { dispatch: 1, review: 0, wait: 200 },
    enabled: true,
    strategy: 'autonomous',
    decisions: [
      {
        cardId: 10,
        projectId: 1,
        action: 'dispatch',
        providerId: 'codex',
        reason: 'Start the next ready board task',
        retry: {
          attemptsUsed: 0,
          attemptsRemaining: 3,
          retryAt: null,
          blocker: null,
        },
      },
      {
        cardId: 20,
        projectId: 1,
        action: 'wait',
        reason: 'Worker capacity reached',
        waitReason: 'project_capacity',
        occupancy: {
          managedWorkers: 1,
          externalWorkers: 2,
          projectWorkers: 1,
        },
        retry: {
          attemptsUsed: 1,
          attemptsRemaining: 2,
          retryAt: '2026-10-10T12:10:00Z',
          blocker: 'Retry cooldown',
        },
      },
    ],
  });

  render(
    <MemoryRouter>
      <OrchestratorPage />
    </MemoryRouter>,
  );

  // Live execution status badge displayed
  expect((await screen.findAllByText(/Checking/)).length).toBeGreaterThanOrEqual(1);

  // Open Preview plan
  fireEvent.click(screen.getByRole('button', { name: 'Preview plan' }));

  expect(await screen.findByText('Plan preview')).toBeDefined();
  expect(screen.getByText('Will dispatch')).toBeDefined();
  expect(screen.getByText('Project busy')).toBeDefined();
  expect(screen.getByText('PM-10')).toBeDefined();
  expect(screen.getByText('PM-20')).toBeDefined();
  expect(screen.getByText(/Managed: 1 · External: 2/)).toBeDefined();
  expect(screen.getByText(/1\/3 used/)).toBeDefined();

  expect(screen.getByRole('button', { name: 'Previous tasks' }).hasAttribute('disabled')).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Next tasks' }));
  await waitFor(() => expect(api.previewOrchestrator).toHaveBeenLastCalledWith('m1', 100));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Next tasks' }).hasAttribute('disabled')).toBe(false),
  );
  expect(api.tickOrchestrators).not.toHaveBeenCalled();

  // Close preview
  fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
  expect(screen.queryByText('Plan preview')).toBeNull();
});

it.each([true, false])(
  'quick actions retain results and respect paused state (enabled=%s)',
  async (enabled) => {
    const master = {
      id: 'quick',
      name: 'Quick master',
      enabled,
      projectIds: [1],
      providers: ['codex'],
      maxWorkers: 2,
      maxWorkersPerProject: 1,
      maxWorkersPerProvider: 1,
      reservePercent: 10,
      allowUnknownQuota: false,
      quotaMaxAgeMs: 60000,
    };
    vi.mocked(api.orchestrators).mockResolvedValue({ instances: [master], events: [] });
    vi.mocked(api.listProjects).mockResolvedValue([
      {
        id: 1,
        name: 'Pending project',
        cardCounts: { todo: 0, in_progress: 0, review: 0, done: 0, backlog: 0 },
        path: '/missing',
        createdAt: '',
        lastScannedAt: null,
        missing: true,
        scan: { status: 'idle', error: null, startedAt: null, moves: [] },
        code: null,
        disk: null,
        git: null,
        boardPreset: 'full',
        runningSessions: 0,
      },
    ]);
    vi.mocked(api.listAllRuns).mockResolvedValue([]);
    vi.mocked(api.listAllSessions).mockResolvedValue([]);
    vi.mocked(api.listCardsInFlight).mockResolvedValue([]);
    vi.mocked(api.resolveOrchestratorAttention).mockResolvedValue({
      ok: true,
      state: { instances: [master], events: [] },
      result: { resolvedCards: [42], dispatchedRuns: enabled ? [10] : [] },
    });
    render(
      <MemoryRouter>
        <OrchestratorPage />
      </MemoryRouter>,
    );
    const button = await screen.findByRole('button', {
      name: enabled ? 'Run pending issues' : 'Queue follow-ups',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Quick run project' }));
    fireEvent.click(
      screen.getByRole('option', { name: 'Pending project' }).querySelector('button')!,
    );
    fireEvent.click(button);
    await waitFor(() => expect(api.resolveOrchestratorAttention).toHaveBeenCalledWith('quick', 1));
    expect((await screen.findByRole('link', { name: 'Task PM-42' })).getAttribute('href')).toBe(
      '/board?card=42',
    );
    expect(screen.getByRole('status').textContent).toContain(
      enabled ? '1 run dispatched' : 'master is paused',
    );
    expect(api.saveOrchestrator).not.toHaveBeenCalled();
    if (enabled) expect(screen.getByRole('link', { name: 'Run #10' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss result' }));
    expect(screen.queryByRole('region', { name: 'Action result' })).toBeNull();
  },
);
