// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { RemoteAccessPanel } from './RemoteAccessPanel';
import type { RemoteStatus } from '../../../shared/types';

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,qr') },
}));
vi.mock('../api', () => ({
  api: {
    remoteStatus: vi.fn(),
    remoteConfigure: vi.fn(),
    remoteBeginTotp: vi.fn(),
    remoteConfirmTotp: vi.fn(),
    setRemote: vi.fn(),
    remoteSignOut: vi.fn(),
  },
}));

const base: RemoteStatus = {
  enabled: false,
  running: false,
  port: null,
  config: { team: '', aud: '', hostname: '', emails: [] },
  totpConfirmed: false,
  pendingTotp: null,
  sessions: [],
  missing: ['Cloudflare team name', 'confirmed authenticator code'],
  error: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('RemoteAccessPanel', () => {
  it('on a remote or LAN device, never asks for settings it may not read', () => {
    vi.stubGlobal('location', { hostname: 'pm.example.com' });
    render(<RemoteAccessPanel onError={vi.fn()} />);
    expect(screen.getByText('managed on the computer')).toBeTruthy();
    expect(api.remoteStatus).not.toHaveBeenCalled();
  });

  it('keeps the switch disabled while anything is missing, and says what', async () => {
    vi.stubGlobal('location', { hostname: '127.0.0.1' });
    vi.mocked(api.remoteStatus).mockResolvedValue(base);
    render(<RemoteAccessPanel onError={vi.fn()} />);
    expect(await screen.findByText(/Still needed: Cloudflare team name/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Turn on remote access' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows a locally drawn QR with the secret while enrolling, and confirms a typed code', async () => {
    vi.stubGlobal('location', { hostname: '127.0.0.1' });
    vi.mocked(api.remoteStatus).mockResolvedValue({
      ...base,
      pendingTotp: {
        secret: 'JBSWY3DPEHPK3PXP',
        otpauth: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP',
      },
    });
    vi.mocked(api.remoteConfirmTotp).mockResolvedValue({ ...base, totpConfirmed: true });
    render(<RemoteAccessPanel onError={vi.fn()} />);
    await screen.findByAltText('Scan with your authenticator app');
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Code from the app'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm code' }));
    await waitFor(() => expect(api.remoteConfirmTotp).toHaveBeenCalledWith('123456'));
  });
});
