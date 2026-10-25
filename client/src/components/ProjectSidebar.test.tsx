// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalApp, ProjectSummary } from '../../../shared/types';
import { api } from '../api';
import { ProjectSidebar, runningAppsLabel } from './ProjectSidebar';

vi.mock('../api', () => ({
  api: {
    listProjects: vi.fn(),
    listAllSessions: vi.fn(async () => []),
    getProjectOrder: vi.fn(async () => ({ order: [] })),
    localApps: vi.fn(),
    getPlanUsage: vi.fn(() => new Promise(() => undefined)),
  },
}));
vi.mock('./PlanUsage', () => ({ PlanUsage: () => null }));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const counts = { backlog: 0, todo: 0, in_progress: 0, review: 0, done: 0 };
const project = (id: number, name: string) =>
  ({
    id,
    name,
    path: `/code/${name}`,
    missing: false,
    runningSessions: 0,
    scan: { status: 'idle', error: null, startedAt: null, moves: [] },
    cardCounts: counts,
    code: null,
    git: null,
  }) as unknown as ProjectSummary;
const app = (port: number, projectId: number | null, web: boolean): LocalApp => ({
  port,
  pid: port,
  name: 'node.exe',
  command: '',
  projectId,
  title: null,
  icon: null,
  web,
});

describe('running app indicator', () => {
  it("marks a project whose web app is running, and only with that project's web ports", async () => {
    vi.mocked(api.listProjects).mockResolvedValue([project(1, 'Probe'), project(2, 'Quiet')]);
    vi.mocked(api.localApps).mockResolvedValue({
      // A web app and an API-only port for Probe; a web app nobody claims.
      apps: [app(3000, 1, true), app(8011, 1, false), app(5181, null, true)],
    });
    render(
      <MemoryRouter>
        <ProjectSidebar />
      </MemoryRouter>,
    );
    const live = await screen.findByRole('img', { name: 'App running: localhost:3000' });
    expect(live.closest('a')?.getAttribute('aria-label')).toContain('Probe');
    expect(screen.getAllByRole('img', { name: /running/ })).toHaveLength(1);
  });

  it('names every running address', () => {
    expect(runningAppsLabel([app(3001, 1, true), app(5173, 1, true)])).toBe(
      '2 apps running: localhost:3001, localhost:5173',
    );
  });
});
