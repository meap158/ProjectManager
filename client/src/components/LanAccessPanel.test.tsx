// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { LanAccessPanel } from './LanAccessPanel';
import QRCode from 'qrcode';
import type { LanStatus } from '../../../shared/types';

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,qr') },
}));

vi.mock('../api', () => ({ api: { lanStatus: vi.fn(() => new Promise(() => undefined)) } }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('LanAccessPanel', () => {
  it('on a LAN device, explains instead of polling settings it may not read', () => {
    vi.stubGlobal('location', { hostname: '192.168.101.4' });
    const onError = vi.fn();
    render(<LanAccessPanel onError={onError} />);
    expect(screen.getByText('this device is signed in')).toBeTruthy();
    expect(api.lanStatus).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('on this computer, loads the LAN status', () => {
    vi.stubGlobal('location', { hostname: '127.0.0.1' });
    render(<LanAccessPanel onError={vi.fn()} />);
    expect(api.lanStatus).toHaveBeenCalled();
  });

  it('shows a locally generated pairing QR using the stable hostname and current code', async () => {
    vi.stubGlobal('location', { hostname: '127.0.0.1' });
    vi.mocked(api.lanStatus).mockResolvedValue({
      enabled: true,
      running: true,
      port: 5180,
      urls: ['http://192.168.1.2:5180/', 'http://host.local:5180/'],
      code: 'ABCD',
      codeExpiresAt: new Date(Date.now() + 600000).toISOString(),
      devices: [],
      error: null,
    } as LanStatus);
    render(<LanAccessPanel onError={vi.fn()} />);
    await screen.findByAltText('Scan to connect to ProjectManager');
    await waitFor(() =>
      expect(QRCode.toDataURL).toHaveBeenCalledWith(
        'http://host.local:5180/#pair=ABCD',
        expect.objectContaining({ margin: 4 }),
      ),
    );
  });
});
