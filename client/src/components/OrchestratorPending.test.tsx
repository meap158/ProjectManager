// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { OrchestratorPending } from './OrchestratorPending';
import type { OrchestratorPendingPage } from '../../../shared/orchestrator';
vi.mock('../api', () => ({ api: { orchestratorPending: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const snapshot: OrchestratorPendingPage = {
  version: 1,
  total: 3,
  offset: 0,
  limit: 10,
  nextOffset: null,
  generatedAt: '2026-10-11T10:00:00Z',
  items: [
    {
      kind: 'project-alert',
      projectId: 1,
      projectName: 'One',
      title: 'Uncommitted files',
      detail: 'Two changed files',
    },
    {
      kind: 'awaiting-review',
      projectId: 1,
      projectName: 'One',
      title: 'Review needed',
      detail: 'Validate the result',
      cardId: 4,
      runId: 7,
    },
    {
      kind: 'needs-input',
      projectId: 1,
      projectName: 'One',
      title: 'Agent needs input',
      detail: 'Choose an option',
      sessionId: 9,
    },
    {
      kind: 'project-alert',
      projectId: 2,
      projectName: 'Two',
      title: 'Other project',
      detail: 'Outside the selected scope',
    },
  ],
};
it('inspects on demand and offers scoped follow-ups and context links', async () => {
  vi.mocked(api.orchestratorPending).mockResolvedValue({
    ...snapshot,
    items: snapshot.items.filter((item) => item.projectId === 1),
  });
  const followUp = vi.fn();
  render(
    <MemoryRouter>
      <OrchestratorPending
        masterId="master"
        projectId={1}
        busy={false}
        canRun={false}
        onFollowUp={followUp}
      />
    </MemoryRouter>,
  );
  expect(api.orchestratorPending).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Inspect pending work' }));
  await screen.findByText('Uncommitted files');
  expect(api.orchestratorPending).toHaveBeenCalledWith('master', 0, 1);

  expect(screen.getByRole('link', { name: 'Review task' }).getAttribute('href')).toBe(
    '/board?card=4',
  );
  expect(screen.getByRole('link', { name: 'Open session' }).getAttribute('href')).toBe(
    '/workspace?open=9',
  );
  expect(screen.getByRole('link', { name: 'Review run #7' }).getAttribute('href')).toBe(
    '/projects/1?tab=agents',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Queue follow-up' }));
  expect(followUp).toHaveBeenCalledWith(1);
});
it('limits visible items and keeps the last inspection after a failed refresh', async () => {
  vi.mocked(api.orchestratorPending)
    .mockResolvedValueOnce({
      ...snapshot,
      total: 12,
      nextOffset: 10,
      items: Array.from({ length: 10 }, (_, index) => ({
        ...snapshot.items[0]!,
        projectId: index + 1,
        title: 'Issue ' + index,
      })),
    })
    .mockResolvedValueOnce({
      ...snapshot,
      total: 12,
      offset: 10,
      nextOffset: null,
      items: [{ ...snapshot.items[0]!, title: 'Issue 11' }],
    })
    .mockRejectedValueOnce(new Error('Inspection unavailable'));
  render(
    <MemoryRouter>
      <OrchestratorPending masterId="master" busy={false} canRun={true} onFollowUp={vi.fn()} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Inspect pending work' }));
  await screen.findByText('Issue 0');
  expect(screen.queryByText('Issue 11')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('Issue 11');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh pending work' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Inspection unavailable');
  expect(screen.getByText('Issue 11')).toBeTruthy();
});

it('reviews owned runs in their Orchestrator instead of the filtered project Agents list', async () => {
  vi.mocked(api.orchestratorPending).mockResolvedValue(snapshot);
  render(
    <MemoryRouter>
      <OrchestratorPending
        masterId="master"
        busy={false}
        canRun={false}
        onFollowUp={vi.fn()}
        runOwners={new Map([[7, 'owner']])}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Inspect pending work' }));
  const link = await screen.findByRole('link', { name: 'Review run #7' });
  expect(link.getAttribute('href')).toBe(
    '/orchestrators?orchestrator=owner&run=7#orchestrator-runs-owner',
  );
});

it('keeps Previous available when pending work shrinks past the current page', async () => {
  vi.mocked(api.orchestratorPending)
    .mockResolvedValueOnce({ ...snapshot, total: 12, nextOffset: 10 })
    .mockResolvedValueOnce({ ...snapshot, total: 3, offset: 10, items: [], nextOffset: null })
    .mockResolvedValueOnce({ ...snapshot, total: 3 });
  render(
    <MemoryRouter>
      <OrchestratorPending masterId="master" busy={false} canRun={false} onFollowUp={vi.fn()} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Inspect pending work' }));
  await screen.findByRole('button', { name: 'Next' });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('This page is empty; pending work changed. Go back or refresh.');
  const previous = screen.getByRole('button', { name: 'Previous' });
  expect((previous as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(previous);
  await screen.findByText('Uncommitted files');
  expect(api.orchestratorPending).toHaveBeenLastCalledWith('master', 0, undefined);
});

it('resets scope and ignores an inspection response from the previous project', async () => {
  let resolve!: (page: OrchestratorPendingPage) => void;
  vi.mocked(api.orchestratorPending)
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce({
      ...snapshot,
      items: [{ ...snapshot.items[0]!, title: 'New project result', projectId: 2 }],
    });
  const view = (projectId: number) => (
    <MemoryRouter>
      <OrchestratorPending
        masterId="master"
        projectId={projectId}
        busy={false}
        canRun={false}
        onFollowUp={vi.fn()}
      />
    </MemoryRouter>
  );
  const { rerender } = render(view(1));
  fireEvent.click(screen.getByRole('button', { name: 'Inspect pending work' }));
  rerender(view(2));
  fireEvent.click(screen.getByRole('button', { name: 'Inspect pending work' }));
  await screen.findByText('New project result');
  await act(async () => resolve(snapshot));
  expect(screen.queryByText('Uncommitted files')).toBeNull();
  expect(screen.getByText('New project result')).toBeDefined();
  expect(api.orchestratorPending).toHaveBeenLastCalledWith('master', 0, 2);
});
