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

vi.mock('../components/LimitsStrip', () => ({ LimitsStrip: () => null }));

vi.mock('../api', () => ({
  api: {
    getWorkspace: vi.fn(),
    saveWorkspace: vi.fn(async (layout: WorkspaceLayout) => layout),
    listAllSessions: vi.fn(),
    listAllRuns: vi.fn(async () => []),
    listProjects: vi.fn(async () => [{ id: 1, name: 'Proj' }]),
    listProviders: vi.fn(async () => []),
    sessionOutput: vi.fn(),
    sessionStreamUrl: vi.fn(() => ''),
    resizeSession: vi.fn(async () => ({ ok: true })),
    sendSessionInput: vi.fn(),
    stopSession: vi.fn(),
    startSession: vi.fn(),
    updateCard: vi.fn(),
    attachCardToSession: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
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
    (p) => p.querySelector('.pane-head .inline-rename')?.textContent ?? 'empty',
  );

describe('Agents workspace interactions', () => {
  it('an empty pane has a close button that shrinks the grid by one (PM-63, PM-68)', async () => {
    localStorage.setItem('pm.workspace.view', 'panes');
    await renderWorkspace({ preset: '2v', panes: [1, null], maximized: null });
    const close = await screen.findByRole('button', { name: 'Close empty pane 2' });
    fireEvent.click(close);
    await waitFor(() =>
      expect(api.saveWorkspace).toHaveBeenLastCalledWith(
        expect.objectContaining({ preset: '1', panes: [1] }),
      ),
    );
  });

  it('brings a selected mobile list terminal into view and lets it maximise and close', async () => {
    localStorage.setItem('pm.workspace.view', 'list');
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    await renderWorkspace({ preset: '1', panes: [1], maximized: null });
    fireEvent.click(screen.getByRole('button', { name: 'Show Alpha' }));
    await screen.findByRole('textbox', { name: 'terminal input' });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }));
    expect(document.querySelector('.workspace-list.has-dock')).not.toBeNull();
    fireEvent.click(screen.getByTitle('Maximise pane'));
    expect(document.querySelector('.workspace-list.is-dock-max')).not.toBeNull();
    fireEvent.click(screen.getByTitle('Remove from layout (keeps the session running)'));
    expect(screen.queryByRole('textbox', { name: 'terminal input' })).toBeNull();
    expect(document.querySelector('.workspace-list.has-dock')).toBeNull();
    expect(api.stopSession).not.toHaveBeenCalled();
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('shows the saved layout with one session per pane', async () => {
    await renderWorkspace({ preset: '2v', panes: [1, 2], maximized: null });
    expect(paneNames()).toEqual(['Alpha', 'Beta']);
  });

  it('Alt+2 focuses pane 2 and Alt+Enter maximises it', async () => {
    await renderWorkspace({ preset: '2v', panes: [1, 2], maximized: null });
    await screen.findByText('Beta');
    await waitFor(() =>
      expect(document.querySelector('[data-pane="1"] .xterm-helper-textarea')).not.toBeNull(),
    );
    fireEvent.keyDown(window, { key: '2', code: 'Digit2', altKey: true });
    await waitFor(
      () =>
        expect(document.activeElement?.closest('[data-pane]')?.getAttribute('data-pane')).toBe('1'),
      { timeout: 3000 },
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Enter', code: 'Enter', altKey: true });
    await waitFor(() => expect(paneNames()).toEqual(['Beta']), { timeout: 3000 });
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

describe('card link in a pane', () => {
  it('unlinks the card without stopping the session', async () => {
    vi.mocked(api.getWorkspace).mockResolvedValue({ preset: '1', panes: [1], maximized: null });
    const linked = { ...session(1, 'Alpha'), cardId: 7, cardKey: 'PM-7' } as AgentSession;
    vi.mocked(api.listAllSessions).mockResolvedValue([linked]);
    vi.mocked(api.attachCardToSession).mockResolvedValue({
      session: { ...linked, cardId: null, cardKey: null } as AgentSession,
      queued: false,
      sent: false,
    });
    render(
      <MemoryRouter>
        <WorkspacePage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink PM-7' }));
    await waitFor(() => expect(screen.queryByText('PM-7')).toBeNull());
    expect(api.attachCardToSession).toHaveBeenCalledWith(1, null);
    expect(api.stopSession).not.toHaveBeenCalled();
  });
});

it('bulk Stop applies only to sessions matching the search filter', async () => {
  localStorage.setItem('pm.workspace.view', 'list');
  vi.mocked(api.stopSession).mockImplementation(async (id) => ({
    ...session(id, id === 1 ? 'Alpha' : 'Beta'),
    status: 'killed',
  }));
  await renderWorkspace({ preset: '1', panes: [null], maximized: null });
  fireEvent.change(screen.getByLabelText('Search agent work by name or card'), {
    target: { value: 'Alpha' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Actions for 1 filtered sessions' }));
  // jsdom does not perform the browser's native popover invoker action.
  fireEvent.click(screen.getByRole('button', { name: 'Stop running (1)', hidden: true }));
  await waitFor(() => expect(api.stopSession).toHaveBeenCalledWith(1));
  expect(api.stopSession).toHaveBeenCalledTimes(1);
});

it('keeps the open terminal mounted when an Idle session becomes Running', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  localStorage.setItem('pm.workspace.view', 'list');
  localStorage.setItem('pm.workspace.listFilters', JSON.stringify({ status: 'idle' }));
  const idle = { ...session(1, 'Alpha'), tailState: 'idle' as const };
  vi.mocked(api.getWorkspace).mockResolvedValue({ preset: '1', panes: [null], maximized: null });
  vi.mocked(api.listAllSessions).mockResolvedValue([idle]);
  render(
    <MemoryRouter>
      <WorkspacePage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Show Alpha' }));
  const terminal = await screen.findByRole('textbox', { name: 'terminal input' });
  terminal.focus();
  fireEvent.change(terminal, { target: { value: 'Continue working' } });
  vi.mocked(api.listAllSessions).mockResolvedValue([
    { ...idle, tailState: 'running', lastOutputAt: new Date().toISOString() },
  ]);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Show Alpha' })).toBeNull(), {
    timeout: 6000,
  });
  expect(screen.getByRole('textbox', { name: 'terminal input' })).toBe(terminal);
  expect(document.activeElement).toBe(terminal);
  expect(document.querySelector('.workspace-list.has-dock')).not.toBeNull();
  expect(api.stopSession).not.toHaveBeenCalled();
}, 10000);

it.each([false, true])(
  'preserves the open terminal across all status tabs and filters (mobile=%s)',
  async (mobile) => {
    vi.stubGlobal('matchMedia', () => ({ matches: mobile }));
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    localStorage.setItem('pm.workspace.view', 'list');
    await renderWorkspace({ preset: '1', panes: [null], maximized: null });
    fireEvent.click(screen.getByRole('button', { name: 'Show Alpha' }));
    const terminal = await screen.findByRole('textbox', { name: 'terminal input' });
    fireEvent.change(terminal, { target: { value: 'Keep my draft' } });
    for (const status of ['Needs attention', 'Running', 'Idle', 'Ended', 'All']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${status}\\s*\\d+$`) }));
      expect(screen.getByRole('textbox', { name: 'terminal input' })).toBe(terminal);
      expect((terminal as HTMLTextAreaElement).value).toBe('Keep my draft');
    }
    fireEvent.change(screen.getByLabelText('Search agent work by name or card'), {
      target: { value: 'No matching session' },
    });
    expect(screen.queryByRole('button', { name: 'Show Alpha' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'terminal input' })).toBe(terminal);
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Kind' }));
    fireEvent.click(screen.getByRole('button', { name: /One-shot runs/ }));
    expect(screen.queryByRole('button', { name: 'Show Alpha' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'terminal input' })).toBe(terminal);
    expect(api.stopSession).not.toHaveBeenCalled();
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  },
);
