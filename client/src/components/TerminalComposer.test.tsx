// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { TerminalComposer, composerPayload } from './TerminalComposer';

vi.mock('../api', () => ({ api: { sendSessionInput: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('TerminalComposer (PM-726)', () => {
  it('sends the whole message as one paste and Enter', () => {
    expect(composerPayload('hi\nthere')).toBe('\x1b[200~hi\nthere\x1b[201~\r');
    expect(composerPayload('a\x1b[201~b')).toBe('\x1b[200~ab\x1b[201~\r');
  });

  it('keeps the draft out of the CLI until Enter, and Shift+Enter adds a line', async () => {
    vi.mocked(api.sendSessionInput).mockResolvedValue({ queued: false } as never);
    render(<TerminalComposer sessionId={4} disabled={false} onError={() => undefined} />);
    const box = screen.getByLabelText('Message to the chat');
    fireEvent.change(box, { target: { value: 'check PM-1' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(api.sendSessionInput).not.toHaveBeenCalled();
    expect(localStorage.getItem('pm.terminalComposer.4')).toBe('check PM-1');
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(api.sendSessionInput).toHaveBeenCalledWith(4, '\x1b[200~check PM-1\x1b[201~\r'),
    );
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
  });
});
