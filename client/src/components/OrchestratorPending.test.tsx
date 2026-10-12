// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { OrchestratorPending } from './OrchestratorPending';
import type { OrchestratorSituation } from '../../../shared/orchestrator';
vi.mock('../api', () => ({ api: { orchestratorSituation: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const snapshot: OrchestratorSituation = {
  generatedAt: '2026-10-11T10:00:00Z',
  beingWorkedOn: [],
  needsAttention: [
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
  vi.mocked(api.orchestratorSituation).mockResolvedValue(snapshot);
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
  expect(api.orchestratorSituation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Inspect pending work' }));
  await screen.findByText('Uncommitted files');
  expect(api.orchestratorSituation).toHaveBeenCalledWith('master');
  expect(screen.queryByText('Other project')).toBeNull();
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
  vi.mocked(api.orchestratorSituation)
    .mockResolvedValueOnce({
      ...snapshot,
      needsAttention: Array.from({ length: 12 }, (_, index) => ({
        ...snapshot.needsAttention[0]!,
        projectId: index + 1,
        title: 'Issue ' + index,
      })),
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
  fireEvent.click(screen.getByRole('button', { name: 'Show more (2)' }));
  expect(screen.getByText('Issue 11')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh pending work' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Inspection unavailable');
  expect(screen.getByText('Issue 11')).toBeTruthy();
});

it('reviews owned runs in their Orchestrator instead of the filtered project Agents list', async () => {
  vi.mocked(api.orchestratorSituation).mockResolvedValue(snapshot);
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
