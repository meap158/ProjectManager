// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleSignedOut, isRemoteClient } from './remote';

const reload = vi.fn();
function at(hostname: string) {
  vi.stubGlobal('location', { hostname, reload });
}

afterEach(() => {
  vi.unstubAllGlobals();
  reload.mockClear();
  sessionStorage.clear();
});

describe('isRemoteClient', () => {
  it('treats loopback names as this computer and anything else as a LAN device', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]'])
      expect(isRemoteClient(host)).toBe(false);
    for (const host of ['192.168.101.4', 'desk.local']) expect(isRemoteClient(host)).toBe(true);
  });
});

describe('handleSignedOut', () => {
  it('reloads a signed-out LAN device to the sign-in page, at most once per 10s', () => {
    at('192.168.101.4');
    handleSignedOut();
    handleSignedOut();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads on this computer', () => {
    at('127.0.0.1');
    handleSignedOut();
    expect(reload).not.toHaveBeenCalled();
  });
});
