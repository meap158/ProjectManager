// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../../shared/types';
import { api } from '../api';
import { BatchSessionMessage } from './BatchSessionMessage';

vi.mock('../api', () => ({ api: { sendSessionInput: vi.fn() } }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const session = (id: number, status = 'running') =>
  ({ id, name: `Agent ${id}`, status, terminal: 'pty' }) as AgentSession;

it('does not force input focus on phones and focuses input on desktop', () => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  const focus = vi.spyOn(HTMLTextAreaElement.prototype, 'focus');
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  render(<BatchSessionMessage sessions={[session(1)]} />);
  fireEvent.click(screen.getByText('Send message (1)'));
  expect(focus).not.toHaveBeenCalled();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  fireEvent.click(screen.getByText('Send message (1)'));
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});

it('sends the continue preset only to the original running recipients', async () => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  vi.mocked(api.sendSessionInput).mockResolvedValue({ queued: false, session: session(1) });
  const view = render(<BatchSessionMessage sessions={[session(1), session(2, 'stopped')]} />);
  fireEvent.click(screen.getByText('Send message (1)'));
  view.rerender(<BatchSessionMessage sessions={[session(1), session(3)]} />);
  fireEvent.click(screen.getByText('Use “continue”'));
  fireEvent.click(screen.getByText('Send to 1'));
  await screen.findByText('Sent to 1 of 1 terminals.');
  expect(api.sendSessionInput).toHaveBeenNthCalledWith(1, 1, '\x1b[200~continue\x1b[201~');
  expect(api.sendSessionInput).toHaveBeenNthCalledWith(2, 1, '\r');
  expect(api.sendSessionInput).toHaveBeenCalledTimes(2);
});

it('keeps only failed recipients for retry and prevents duplicate submissions', async () => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  vi.mocked(api.sendSessionInput).mockImplementation(async (id) => {
    if (id === 2) throw new Error('Disconnected');
    return { queued: false, session: session(1) };
  });
  render(<BatchSessionMessage sessions={[session(1), session(2)]} />);
  fireEvent.click(screen.getByText('Send message (2)'));
  fireEvent.click(screen.getByText('Use “continue”'));
  fireEvent.click(screen.getByText('Send to 2'));
  await waitFor(() =>
    expect(screen.getByRole('status', { hidden: true }).textContent).toContain('Failed: Agent 2'),
  );
  vi.mocked(api.sendSessionInput)
    .mockClear()
    .mockResolvedValue({ queued: false, session: session(1) });
  fireEvent.click(screen.getByText('Send to 1'));
  await screen.findByText('Sent to 1 of 1 terminals.');
  expect(api.sendSessionInput).toHaveBeenCalledTimes(2);
  expect(api.sendSessionInput).toHaveBeenCalledWith(2, '\r');
});

it('shows completed recipients and the current delivery stage while requests are pending', async () => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  let release!: () => void;
  const response = { queued: false, session: session(1) };
  vi.mocked(api.sendSessionInput).mockImplementation(async (id, data) => {
    if (id === 2 && data !== '\r')
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return response;
  });
  render(<BatchSessionMessage sessions={[session(1), session(2)]} />);
  fireEvent.click(screen.getByText('Send message (2)'));
  fireEvent.click(screen.getByText('Use “continue”'));
  fireEvent.click(screen.getByText('Send to 2'));
  await waitFor(() =>
    expect(screen.getByRole('status', { hidden: true }).textContent).toContain(
      '1/2 complete · Adding message: Agent 2 · 1 sent',
    ),
  );
  expect(screen.getByRole('progressbar', { hidden: true }).getAttribute('value')).toBe('1');
  release();
  await screen.findByText('Sent to 2 of 2 terminals.');
  expect(screen.getByRole('progressbar', { hidden: true }).getAttribute('value')).toBe('2');
  expect(screen.queryByText('Send to 0')).toBeNull();
});

it('keeps queued delivery visible without automatically closing or offering duplicate retries', async () => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  vi.mocked(api.sendSessionInput).mockResolvedValue({ queued: true, session: session(1) });
  render(<BatchSessionMessage sessions={[session(1)]} />);
  fireEvent.click(screen.getByText('Send message (1)'));
  fireEvent.click(screen.getByText('Use “continue”'));
  fireEvent.click(screen.getByText('Send to 1'));
  await screen.findByText('Sent to 0 of 1 terminals. 1 queued; delivery not confirmed.');
  expect(screen.getByRole('progressbar', { hidden: true }).getAttribute('value')).toBe('1');
  expect(screen.queryByText(/Closing automatically/)).toBeNull();
  expect(screen.queryByText('Send to 0')).toBeNull();
  expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled();
});

it('shows successful completion for three seconds before closing', async () => {
  vi.useFakeTimers();
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  vi.mocked(api.sendSessionInput).mockResolvedValue({ queued: false, session: session(1) });
  render(<BatchSessionMessage sessions={[session(1)]} />);
  fireEvent.click(screen.getByText('Send message (1)'));
  fireEvent.click(screen.getByText('Use “continue”'));
  await act(async () => {
    fireEvent.click(screen.getByText('Send to 1'));
  });
  expect(screen.getByText('Sent to 1 of 1 terminals.')).toBeTruthy();
  expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled();
  await act(async () => {
    vi.advanceTimersByTime(2999);
  });
  expect(HTMLDialogElement.prototype.close).not.toHaveBeenCalled();
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(HTMLDialogElement.prototype.close).toHaveBeenCalledOnce();
});
