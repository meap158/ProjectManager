// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, WorkspaceLayout } from '../../../shared/types';
import { api } from '../api';
import { WorkspacePage } from './WorkspacePage';

// The real terminal (xterm) needs a canvas; a focusable stand-in is enough for the page logic.
vi.mock('../components/TerminalView', () => ({
  TerminalView: () => <textarea className="xterm-helper-textarea" aria-label="terminal input" />,
}));

vi.mock('../api', () => ({
  api: {
    getWorkspace: vi.fn(),
    saveWorkspace: vi.fn(async (layout: WorkspaceLayout) => layout),
    listAllSessions: vi.fn(),
    listProjects: vi.fn(async () => [{ id: 1, name: 'Proj' }]),
    listProviders: vi.fn(async () => []),
    sessionOutput: vi.fn(),
    sessionStreamUrl: vi.fn(() => ''),
    resizeSession: vi.fn(async () => ({ ok: true })),
    sendSessionInput: vi.fn(),
    stopSession: vi.fn(),
    startSession: vi.fn(),
    updateCard: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const session = (id: number, name: string): AgentSession =>
  ({
    id,
    projectId: 1,
    name,
    providerId: 'shell',
    command: ['cmd.exe'],
    cwd: 'C:\\code',
    terminal: 'pty',
    cardId: null,
    cardKey: null,
    pid: 100 + id,
    status: 'running',
  }) as unknown as AgentSession;

async function renderWorkspace(layout: WorkspaceLayout) {
  vi.mocked(api.getWorkspace).mockResolvedValue(layout);
  vi.mocked(api.listAllSessions).mockResolvedValue([session(1, 'Alpha'), session(2, 'Beta')]);
  render(
    <MemoryRouter>
      <WorkspacePage />
    </MemoryRouter>,
  );
  await screen.findByText('Alpha');
}
const paneNames = () =>
  [...document.querySelectorAll('[data-pane]')].map(
    (p) => p.querySelector('.pane-head b')?.textContent ?? 'empty',
  );

describe('Agents workspace interactions', () => {
  it('shows the saved layout with one session per pane', async () => {
    await renderWorkspace({ preset: '2v', panes: [1, 2], maximized: null });
    expect(paneNames()).toEqual(['Alpha', 'Beta']);
  });

  it('Alt+2 focuses pane 2 and Alt+Enter maximises it', async () => {
    await renderWorkspace({ preset: '2v', panes: [1, 2], maximized: null });
    fireEvent.keyDown(window, { key: '2', code: 'Digit2', altKey: true });
    await waitFor(() =>
      expect(document.activeElement?.closest('[data-pane]')?.getAttribute('data-pane')).toBe('1'),
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Enter', code: 'Enter', altKey: true });
    await waitFor(() => expect(paneNames()).toEqual(['Beta']));
  });

  it('swaps panes by dragging a header and saves the new order', async () => {
    await renderWorkspace({ preset: '2v', panes: [1, 2], maximized: null });
    const [first, second] = [...document.querySelectorAll('[data-pane]')];
    const head = first!.querySelector('.pane-head')!;
    const dataTransfer = { setData: () => undefined, effectAllowed: '' };
    fireEvent.dragStart(head, { dataTransfer });
    fireEvent.dragOver(second!, { dataTransfer });
    fireEvent.drop(second!, { dataTransfer });
    expect(paneNames()).toEqual(['Beta', 'Alpha']);
    await waitFor(() =>
      expect(api.saveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ panes: [2, 1] })),
    );
  });

  it('changes the text size and remembers it with the layout', async () => {
    await renderWorkspace({ preset: '1', panes: [1], maximized: null });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Larger terminal text' }));
    });
    expect(screen.getByRole('group', { name: 'Text size' }).textContent).toContain('13.5');
    await waitFor(() =>
      expect(api.saveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 13.5 })),
    );
  });
});
