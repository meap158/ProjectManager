// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { TerminalComposer, composerPayload } from './TerminalComposer';

vi.mock('../api', () => ({
  api: { sendSessionInput: vi.fn(), uploadSessionImage: vi.fn() },
}));
URL.createObjectURL = vi.fn(() => 'blob:preview');
URL.revokeObjectURL = vi.fn();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('TerminalComposer (PM-726)', () => {
  it('preserves edits made during a pending send and ignores repeated submission', async () => {
    let finish!: (value: never) => void;
    vi.mocked(api.sendSessionInput).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<TerminalComposer sessionId={4} disabled={false} onError={() => undefined} />);
    const box = screen.getByLabelText('Message to the chat');
    fireEvent.change(box, { target: { value: 'first message' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(api.sendSessionInput).toHaveBeenCalledTimes(1);
    fireEvent.change(box, { target: { value: 'next draft' } });
    finish({ queued: false } as never);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy());
    expect((box as HTMLTextAreaElement).value).toBe('next draft');
  });
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

describe('TerminalComposer images (PM-929)', () => {
  const png = () =>
    new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });

  it('uploads a pasted image, shows it, and sends its path as its own paste before the text', async () => {
    vi.mocked(api.uploadSessionImage).mockResolvedValue({ path: 'D:/data/shot.png' } as never);
    vi.mocked(api.sendSessionInput).mockResolvedValue({ queued: false } as never);
    render(<TerminalComposer sessionId={4} disabled={false} onError={() => undefined} />);
    const box = screen.getByLabelText('Message to the chat');
    fireEvent.paste(box, { clipboardData: { files: [png()], items: [] } });
    expect(await screen.findByAltText('shot.png')).toBeTruthy();
    await waitFor(() => expect(api.uploadSessionImage).toHaveBeenCalledTimes(1));
    fireEvent.change(box, { target: { value: 'what is wrong here?' } });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(api.sendSessionInput).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.sendSessionInput).mock.calls).toEqual([
      [4, '\x1b[200~D:/data/shot.png\x1b[201~'],
      [4, '\x1b[200~what is wrong here?\x1b[201~\r'],
    ]);
    await waitFor(() => expect(screen.queryByAltText('shot.png')).toBeNull());
  });

  it('sends an image on its own with just Enter, and leaves plain text pastes alone', async () => {
    vi.mocked(api.uploadSessionImage).mockResolvedValue({ path: 'D:/data/a.png' } as never);
    vi.mocked(api.sendSessionInput).mockResolvedValue({ queued: false } as never);
    render(<TerminalComposer sessionId={4} disabled={false} onError={() => undefined} />);
    const box = screen.getByLabelText('Message to the chat');
    expect(fireEvent.paste(box, { clipboardData: { files: [], items: [] } })).toBe(true);
    fireEvent.paste(box, { clipboardData: { files: [png()], items: [] } });
    await waitFor(() => expect(api.uploadSessionImage).toHaveBeenCalled());
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.sendSessionInput).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.sendSessionInput).mock.calls[1]).toEqual([4, '\r']);
  });

  it('refuses a dropped file that is not an image, with a reason, and sends nothing', async () => {
    render(<TerminalComposer sessionId={4} disabled={false} onError={() => undefined} />);
    const form = screen.getByLabelText('Message to the chat').closest('form')!;
    fireEvent.drop(form, {
      dataTransfer: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })], items: [] },
    });
    expect(await screen.findByText('That file is not an image.')).toBeTruthy();
    expect(api.uploadSessionImage).not.toHaveBeenCalled();
  });
});
