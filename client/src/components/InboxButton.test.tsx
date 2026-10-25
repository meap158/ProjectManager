// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../../shared/types';

const state = vi.hoisted(() => ({ list: [] as unknown[], screens: [] as string[] }));
vi.mock('../api', () => ({
  api: {
    listAllSessions: vi.fn(async () => state.list),
    listProjects: vi.fn(async () => [{ id: 1, name: 'Alpha' }]),
    // Each read takes the next screen; the last one repeats.
    sessionScreen: vi.fn(async () => ({
      text: state.screens.length > 1 ? state.screens.shift()! : (state.screens[0] ?? ''),
    })),
    sessionTranscript: vi.fn(async () => ({
      items: [
        { id: 'u', kind: 'user', text: 'fix it', at: null },
        { id: 'a', kind: 'assistant', text: '## Done\n\nThe **login** bug is fixed.', at: null },
      ],
      next: 0,
      reset: false,
    })),
    sendSessionInput: vi.fn(async () => ({ queued: false })),
    restartSession: vi.fn(async () => ({})),
  },
}));

import { api } from '../api';
import { InboxButton, inboxItems } from './InboxButton';

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api.sendSessionInput).mockClear();
});
afterEach(cleanup);

const s = (id: number, patch: Partial<AgentSession>) =>
  ({
    id,
    name: `s${id}`,
    projectId: 1,
    providerId: 'claude',
    terminal: 'pty',
    status: 'running',
    tailState: 'idle',
    cardKey: null,
    lastInputAt: null,
    lastOutputAt: null,
    ...patch,
  }) as AgentSession;

const MENU = [
  'Do you want to make this edit to app.ts?',
  '❯ 1. Yes',
  '  2. No, and tell Claude what to do differently',
  'Esc to cancel',
].join('\n');

const show = () =>
  render(
    <MemoryRouter>
      <InboxButton />
    </MemoryRouter>,
  );

describe('inboxItems', () => {
  it('lists decisions, failures, limits, then finished turns, skipping the rest', () => {
    const items = inboxItems([
      s(1, { restartProgress: 'failed' }),
      s(2, { tailState: 'input' }),
      s(3, {}), // idle, never messaged
      s(4, { tailState: 'input', status: 'exited' }),
      s(5, { tailState: 'input', orchestratorId: 'o' }),
      s(6, { lastInputAt: '2026-01-01T00:00:00Z', lastOutputAt: '2026-01-01T00:05:00Z' }),
      s(7, { usageLimit: { resetsAt: null } }),
      // Still working on your message.
      s(8, {
        tailState: 'running',
        lastInputAt: '2026-01-01T00:00:00Z',
        lastOutputAt: '2026-01-01T00:05:00Z',
      }),
    ]);
    expect(items.map((i) => [i.session.id, i.reason])).toEqual([
      [2, 'input'],
      [1, 'restart-failed'],
      [7, 'limit'],
      [6, 'finished'],
    ]);
    expect(items[3]!.key).toBe('6:finished:2026-01-01T00:00:00Z');
  });
});

describe('InboxButton', () => {
  it('shows the question and answers it in place after re-reading the screen', async () => {
    state.list = [s(7, { tailState: 'input', name: 'Fix login', cardKey: 'PM-9' })];
    state.screens = [MENU];
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Inbox, 1 waiting for you' }));
    const row = await screen.findByRole('link', { name: /Fix login · PM-9/ });
    expect(row.getAttribute('href')).toBe('/workspace?open=7');
    expect(await screen.findByText('Do you want to make this edit to app.ts?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '1. Yes' }));
    await waitFor(() => expect(api.sendSessionInput).toHaveBeenCalledWith(7, '1'));
    expect(await screen.findByText('1. Yes: sent.')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not answer when the prompt changed in the meantime', async () => {
    state.list = [s(7, { tailState: 'input' })];
    state.screens = [MENU, 'Allow network access?\n❯ 1. Allow\n  2. Deny\nEsc to cancel'];
    show();
    fireEvent.click(await screen.findByRole('button', { name: /Inbox/ }));
    fireEvent.click(await screen.findByRole('button', { name: '1. Yes' }));
    expect(await screen.findByText(/The prompt changed/)).toBeTruthy();
    expect(api.sendSessionInput).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: '1. Allow' })).toBeTruthy();
  });

  it('shows a finished reply, sends a reply, and remembers what was seen', async () => {
    state.list = [
      s(3, {
        name: 'Docs',
        lastInputAt: '2026-01-01T00:00:00Z',
        lastOutputAt: '2026-01-01T00:05:00Z',
      }),
    ];
    state.screens = ['> '];
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Inbox, 1 waiting for you' }));
    expect(await screen.findByText('Done The login bug is fixed.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Reply to Docs'), { target: { value: 'ship it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendSessionInput).toHaveBeenLastCalledWith(3, '\r'));
    expect(api.sendSessionInput).toHaveBeenCalledWith(3, '\x1b[200~ship it\x1b[201~');
    // Answering marks it seen: the badge clears, and stays cleared after a reload.
    expect(await screen.findByRole('button', { name: 'Inbox, nothing new' })).toBeTruthy();
    cleanup();
    show();
    expect(await screen.findByRole('button', { name: 'Inbox, nothing new' })).toBeTruthy();
  });

  it('says nothing is waiting when nothing is', async () => {
    state.list = [s(1, {})];
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Inbox, nothing new' }));
    expect(screen.getByText(/Nothing is waiting/)).toBeTruthy();
  });
});
