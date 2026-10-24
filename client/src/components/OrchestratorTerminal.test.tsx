// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../../shared/types';
import { OrchestratorTerminal } from './OrchestratorTerminal';
import { api } from '../api';
vi.mock('../api', () => ({
  api: { stopSession: vi.fn(), startSession: vi.fn(), restartSession: vi.fn() },
}));
vi.mock('./TerminalView', () => ({ TerminalView: () => null }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});
const session = {
  id: 41,
  name: 'Master',
  status: 'running',
  terminal: 'pty',
  startedAt: '2026-10-12',
  logBytes: 0,
} as AgentSession;
it('stops the master and refreshes its state only after success', async () => {
  vi.mocked(api.stopSession).mockResolvedValue({ ...session, status: 'killed' });
  const refresh = vi.fn();
  const changed = vi.fn();
  render(<OrchestratorTerminal session={session} onChanged={refresh} onSessionChanged={changed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Stop Master' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(api.stopSession).toHaveBeenCalledWith(41);
  expect(changed).toHaveBeenCalledWith(expect.objectContaining({ id: 41, status: 'killed' }));
});
it('reports stop failures and keeps lifecycle controls available', async () => {
  vi.mocked(api.stopSession).mockRejectedValue(new Error('Connection interrupted'));
  const refresh = vi.fn();
  render(<OrchestratorTerminal session={session} onChanged={refresh} />);
  fireEvent.click(screen.getByRole('button', { name: 'Stop Master' }));
  expect(await screen.findByRole('alert')).toBeDefined();
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Stop Master' }).closest('fieldset')?.disabled).toBe(
    false,
  );
});
it('toggles full screen from the header and restores it with Escape (PM-138)', () => {
  render(<OrchestratorTerminal session={session} onChanged={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Restore layout' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
  const restore = screen.getByRole('button', { name: 'Restore layout' });
  expect(restore.getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('.orchestrator-terminal.is-max')).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(document.querySelector('.orchestrator-terminal.is-max')).toBeNull();
  expect(screen.getByRole('button', { name: 'Full screen' })).toBeDefined();
});
it('toggles full screen by double-clicking the header', () => {
  render(<OrchestratorTerminal session={session} onChanged={vi.fn()} />);
  fireEvent.doubleClick(screen.getByText('running').parentElement!);
  expect(document.querySelector('.orchestrator-terminal.is-max')).toBeTruthy();
});

it('persists full-screen expanded state across navigation remounts (PM-163)', () => {
  const { unmount } = render(<OrchestratorTerminal session={session} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
  expect(document.querySelector('.orchestrator-terminal.is-max')).toBeTruthy();

  unmount();

  render(<OrchestratorTerminal session={session} onChanged={vi.fn()} />);
  expect(document.querySelector('.orchestrator-terminal.is-max')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Restore layout' })).toBeDefined();
});

it('resizes terminal height with keyboard and persists in localStorage', () => {
  render(<OrchestratorTerminal session={session} onChanged={vi.fn()} />);
  const resizer = screen.getByRole('separator', { name: 'Resize orchestrator terminal' });
  expect(resizer.getAttribute('aria-valuenow')).toBe('480');

  // Expand with ArrowDown (+24px -> 504px)
  fireEvent.keyDown(resizer, { key: 'ArrowDown' });
  expect(resizer.getAttribute('aria-valuenow')).toBe('504');
  expect(localStorage.getItem('pm.orchestrator.terminalHeight')).toBe('504');

  // Shrink with ArrowUp (-24px -> 480px)
  fireEvent.keyDown(resizer, { key: 'ArrowUp' });
  expect(resizer.getAttribute('aria-valuenow')).toBe('480');

  // Double-click resets height
  fireEvent.keyDown(resizer, { key: 'ArrowDown' });
  expect(resizer.getAttribute('aria-valuenow')).toBe('504');
  fireEvent.doubleClick(resizer);
  expect(resizer.getAttribute('aria-valuenow')).toBe('480');
  expect(localStorage.getItem('pm.orchestrator.terminalHeight')).toBeNull();
});

it('hides the terminal resizer when maximized in full screen', () => {
  render(<OrchestratorTerminal session={session} onChanged={vi.fn()} />);
  expect(screen.getByRole('separator', { name: 'Resize orchestrator terminal' })).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
  expect(screen.queryByRole('separator', { name: 'Resize orchestrator terminal' })).toBeNull();
});
