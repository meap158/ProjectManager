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
