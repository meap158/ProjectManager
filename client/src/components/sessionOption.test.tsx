// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sessionOption } from './sessionOption';

describe('sessionOption', () => {
  it('names the agent in the secondary line of a renamed session', () => {
    const o = sessionOption(
      { id: 4, name: 'Attribution Products 4', providerId: 'codex' },
      'TrendRelay',
      'this app',
    );
    expect(o.sub).toBe('Codex · TrendRelay');
    expect(o.hint).toBe('this app');
    expect(o.icon).toBeTruthy();
  });
  it('does not repeat the agent when the session is named after it', () => {
    expect(
      sessionOption({ id: 1, name: 'Claude Code', providerId: 'claude' }, 'TrendRelay').sub,
    ).toBe('TrendRelay');
  });
  it('falls back to the provider id for an unknown agent', () => {
    expect(sessionOption({ id: 2, name: 'x', providerId: 'newcli' }, 'P').sub).toBe('newcli · P');
  });
});
