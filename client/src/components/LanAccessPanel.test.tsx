// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { LanAccessPanel } from './LanAccessPanel';

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
});
