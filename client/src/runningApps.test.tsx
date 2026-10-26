// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { LocalApp } from '../../shared/types';
import { api } from './api';
import { resetRunningApps, useRunningApps } from './runningApps';

vi.mock('./api', () => ({ api: { localApps: vi.fn() } }));
afterEach(() => {
  cleanup();
  resetRunningApps();
});

const app = (port: number, projectId: number | null, web = true) =>
  ({
    port,
    pid: port,
    name: 'node',
    command: '',
    projectId,
    title: null,
    icon: null,
    web,
  }) as LocalApp;

function Ports({ id }: { id: number }) {
  const apps = useRunningApps().get(id);
  return <p>{`project ${id}: ${apps?.map((a) => a.port).join(',') ?? 'none'}`}</p>;
}

it("shares one poll between every place that shows a project's running apps (PM-309)", async () => {
  vi.mocked(api.localApps).mockResolvedValue({
    apps: [app(3000, 1), app(8011, 1, false), app(5173, 2), app(9000, null)],
  });
  render(
    <>
      <Ports id={1} />
      <Ports id={2} />
      <Ports id={3} />
    </>,
  );
  expect(await screen.findByText('project 1: 3000')).toBeTruthy();
  expect(screen.getByText('project 2: 5173')).toBeTruthy();
  expect(screen.getByText('project 3: none')).toBeTruthy();
  expect(api.localApps).toHaveBeenCalledTimes(1);
});
