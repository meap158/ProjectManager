// @vitest-environment jsdom
import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentRun } from '../../../shared/types';
import { RunCard } from './RunCard';
import { api } from '../api';
vi.mock('../api', () => ({ api: { resolveUnknownRun: vi.fn() } }));
vi.mock('./TerminalView', () => ({ TerminalView: () => null }));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const run = (nonce = '00000000-0000-4000-8000-000000000001'): AgentRun => ({
  id: 1,
  projectId: 1,
  cardId: null,
  cardKey: null,
  name: 'Unknown worker',
  providerId: 'custom',
  command: ['fixture'],
  prompt: '',
  autonomy: 'read',
  changes: null,
  status: 'running',
  exitCode: null,
  error: 'Execution unknown',
  attempts: 1,
  maxAttempts: 1,
  validation: null,
  validatedAt: null,
  validatedMove: null,
  createdAt: '2026-10-16T00:00:00Z',
  startedAt: null,
  endedAt: null,
  logBytes: 0,
  executionState: 'unknown',
  executionNonce: nonce,
});

it('requires a separate focused confirmation before resolving unknown execution', async () => {
  const item = run();
  const changed = vi.fn();
  vi.mocked(api.resolveUnknownRun).mockResolvedValue({
    ...item,
    status: 'failed',
    executionState: 'complete',
  });
  render(<RunCard run={item} now={Date.now()} onChanged={changed} onDeleted={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Resolve unknown execution' }));
  const dialog = screen.getByRole('dialog', { name: 'Have you verified this worker has stopped?' });
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(api.resolveUnknownRun).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'I verified the worker has stopped' }),
  );
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(api.resolveUnknownRun).toHaveBeenCalledWith(item.id, item.executionNonce);
});

it('discards an open confirmation when the execution identity changes', () => {
  const props = { now: Date.now(), onChanged: vi.fn(), onDeleted: vi.fn() };
  const { rerender } = render(<RunCard run={run()} {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Resolve unknown execution' }));
  expect(screen.queryByRole('dialog')).not.toBeNull();
  rerender(<RunCard run={run('00000000-0000-4000-8000-000000000002')} {...props} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.resolveUnknownRun).not.toHaveBeenCalled();
});
