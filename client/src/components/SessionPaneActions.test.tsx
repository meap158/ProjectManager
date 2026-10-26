// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../../shared/types';
import { api } from '../api';
import { SessionPaneActions } from './SessionPaneActions';

vi.mock('../api', () => ({
  api: {
    updateCard: vi.fn(async () => ({})),
    restartSession: vi.fn(),
    stopSession: vi.fn(),
    startSession: vi.fn(),
    sendSessionInput: vi.fn(async () => ({ queued: false })),
  },
}));
afterEach(cleanup);

const session = (patch: Partial<AgentSession> = {}) =>
  ({
    id: 7,
    name: 'Builder',
    providerId: 'claude',
    status: 'running',
    terminal: 'pty',
    cardId: null,
    cardKey: null,
    supervise: true,
    restartProgress: null,
    ...patch,
  }) as AgentSession;

const props = { pasteRef: { current: null }, onChanged: vi.fn(), onError: vi.fn() };

describe('session pane actions, the same in every pane', () => {
  it('offers Continue, Restart and Stop on a running CLI, and hands its card to Review', async () => {
    render(
      <SessionPaneActions
        session={session({ cardId: 12, cardKey: 'PM-12' })}
        view="terminal"
        {...props}
      />,
    );
    expect(screen.getByRole('button', { name: 'Continue Builder' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart Builder' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '→ Review' }));
    await waitFor(() => expect(api.updateCard).toHaveBeenCalledWith(12, { status: 'review' }));
    expect(await screen.findByText('PM-12 → Review')).toBeTruthy();
  });

  it('leaves image and Continue to the chat composer, and offers Start and Dispose once a task ended', () => {
    const { rerender } = render(<SessionPaneActions session={session()} view="chat" {...props} />);
    expect(screen.queryByRole('button', { name: 'Continue Builder' })).toBeNull();
    rerender(
      <SessionPaneActions
        session={session({ status: 'exited', cardId: 3, cardKey: 'PM-3', supervise: false })}
        view="terminal"
        onDeleted={vi.fn()}
        {...props}
      />,
    );
    expect(screen.getByRole('button', { name: 'Start session' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Dispose Builder/ })).toBeTruthy();
  });
});
