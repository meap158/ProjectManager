// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../../shared/types';

const sessions = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('../api', () => ({
  api: {
    listAllSessions: vi.fn(async () => sessions.list),
    listProjects: vi.fn(async () => [{ id: 1, name: 'Alpha' }]),
  },
}));

import { InboxButton, inboxItems } from './InboxButton';

afterEach(cleanup);

const s = (id: number, patch: Partial<AgentSession>) =>
  ({
    id,
    name: `s${id}`,
    projectId: 1,
    status: 'running',
    tailState: 'idle',
    cardKey: null,
    ...patch,
  }) as AgentSession;

describe('inboxItems', () => {
  it('lists sessions asking for input and failed restarts, input first, skipping the rest', () => {
    const items = inboxItems([
      s(1, { restartProgress: 'failed' }),
      s(2, { tailState: 'input' }),
      s(3, {}),
      s(4, { tailState: 'input', status: 'exited' }),
      s(5, { tailState: 'input', orchestratorId: 'o' }),
    ]);
    expect(items.map((i) => [i.session.id, i.reason])).toEqual([
      [2, 'input'],
      [1, 'restart-failed'],
    ]);
  });
});

describe('InboxButton', () => {
  it('shows a count, and opens a panel whose rows open the session', async () => {
    sessions.list = [s(7, { tailState: 'input', name: 'Fix login', cardKey: 'PM-9' })];
    render(
      <MemoryRouter>
        <InboxButton />
      </MemoryRouter>,
    );
    const button = await screen.findByRole('button', { name: 'Inbox, 1 waiting for you' });
    fireEvent.click(button);
    const row = await screen.findByRole('link', { name: /Fix login · PM-9/ });
    expect(row.getAttribute('href')).toBe('/workspace?open=7');
    await waitFor(() => expect(screen.getByText(/Alpha/)).toBeTruthy());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says nothing is waiting when nothing is', async () => {
    sessions.list = [s(1, {})];
    render(
      <MemoryRouter>
        <InboxButton />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Inbox, nothing waiting' }));
    expect(screen.getByText(/Nothing is waiting/)).toBeTruthy();
  });
});
