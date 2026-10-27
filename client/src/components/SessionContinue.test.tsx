// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../../shared/types';
import { api } from '../api';
import { RESULT_MS, SessionContinue } from './SessionContinue';
vi.mock('../api', () => ({ api: { sendSessionInput: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const session = {
  id: 4,
  name: 'Worker',
  providerId: 'codex',
  status: 'running',
  terminal: 'pty',
} as AgentSession;

it('submits continue in order once despite duplicate clicks and reports queued input', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api.sendSessionInput).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish;
      }),
  );
  vi.mocked(api.sendSessionInput).mockResolvedValueOnce({ session, queued: false });
  render(<SessionContinue session={session} onError={vi.fn()} />);
  const button = screen.getByRole('button', { name: 'Continue Worker' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(api.sendSessionInput).toHaveBeenCalledTimes(1);
  finish({ session, queued: true });
  await screen.findByText('Continue queued for reconnection');
  expect(vi.mocked(api.sendSessionInput).mock.calls).toEqual([
    [4, '\x1b[200~continue\x1b[201~'],
    [4, '\r'],
  ]);
});

it('does not submit Enter after a failed message', async () => {
  const onError = vi.fn();
  vi.mocked(api.sendSessionInput).mockRejectedValue(new Error('Disconnected'));
  render(<SessionContinue session={session} onError={onError} />);
  fireEvent.click(screen.getByRole('button', { name: 'Continue Worker' }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith('Disconnected'));
  expect(api.sendSessionInput).toHaveBeenCalledTimes(1);
});

it('uses newline for pipe sessions and hides the shortcut for shells and ended sessions', async () => {
  vi.mocked(api.sendSessionInput).mockResolvedValue({ session, queued: false });
  const view = render(
    <SessionContinue session={{ ...session, terminal: 'pipe' }} onError={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Continue Worker' }));
  await screen.findByText('Continue sent');
  expect(vi.mocked(api.sendSessionInput).mock.calls).toEqual([
    [4, 'continue'],
    [4, '\n'],
  ]);
  view.rerender(
    <SessionContinue session={{ ...session, providerId: 'shell' }} onError={vi.fn()} />,
  );
  expect(screen.queryByRole('button')).toBeNull();
  view.rerender(<SessionContinue session={{ ...session, status: 'exited' }} onError={vi.fn()} />);
  expect(screen.queryByRole('button')).toBeNull();
});

it('shows Sent for a moment, then reads Continue again', async () => {
  vi.mocked(api.sendSessionInput).mockResolvedValue({ session, queued: false });
  render(<SessionContinue session={session} onError={vi.fn()} />);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fireEvent.click(screen.getByRole('button', { name: 'Continue Worker' }));
  await screen.findByText('Sent');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RESULT_MS);
  });
  expect(screen.getByText('Continue')).toBeTruthy();
  expect(screen.queryByText('Sent')).toBeNull();
  vi.useRealTimers();
});
