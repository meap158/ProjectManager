import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SILENT_MS, forgetTurn, persistTurns, recordEvent, turnState } from './turnState.js';

// Claude's own hooks say exactly when a turn starts and ends; the screen is only a sanity check.

const iso = (ms: number) => new Date(ms).toISOString();

describe('turnState', () => {
  it('is unknown until a hook reports, then follows prompt → stop', () => {
    expect(turnState(1, null)).toBeNull();
    recordEvent(1, 'SessionStart', null, 0);
    expect(turnState(1, iso(0), 1000)).toBe('idle');
    recordEvent(1, 'UserPromptSubmit', null, 1000);
    expect(turnState(1, iso(5000), 6000)).toBe('running');
    recordEvent(1, 'Stop', null, 7000);
    expect(turnState(1, iso(7000), 8000)).toBe('idle');
    forgetTurn(1);
    expect(turnState(1, null)).toBeNull();
  });

  it('asking you (permission, question) means input; idle_prompt means idle; others nothing', () => {
    recordEvent(2, 'UserPromptSubmit', null, 0);
    recordEvent(2, 'Notification', 'agent_completed', 100);
    expect(turnState(2, iso(100), 200)).toBe('running');
    recordEvent(2, 'Notification', 'permission_prompt', 300);
    expect(turnState(2, iso(300), 400)).toBe('input');
    recordEvent(2, 'UserPromptSubmit', null, 500); // Answered and back to work.
    expect(turnState(2, iso(500), 600)).toBe('running');
    recordEvent(2, 'Notification', 'idle_prompt', 700);
    expect(turnState(2, iso(700), 800)).toBe('idle');
  });

  it('subagents keep it running after the turn ends, until they stop', () => {
    recordEvent(3, 'UserPromptSubmit', null, 0);
    recordEvent(3, 'SubagentStart', null, 10);
    recordEvent(3, 'Stop', null, 20);
    expect(turnState(3, iso(20), 30)).toBe('running');
    recordEvent(3, 'SubagentStop', null, 40);
    expect(turnState(3, iso(40), 50)).toBe('idle');
  });

  it('"running" with a silent screen (Esc skips Stop) turns idle', () => {
    recordEvent(4, 'UserPromptSubmit', null, 0);
    expect(turnState(4, iso(1000), 1000 + SILENT_MS + 1)).toBe('idle');
    expect(turnState(4, iso(1000), 1000 + SILENT_MS - 1)).toBe('running');
  });
});

describe('persistTurns', () => {
  it('restores saved idle turns after a restart, and saves only idle ones', () => {
    vi.useFakeTimers();
    try {
      const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'pm-turns-')), 'turns.json');
      writeFileSync(file, JSON.stringify({ 9001: 5 }));
      persistTurns(file);
      expect(turnState(9001, null, 10)).toBe('idle'); // Restored, not unknown.
      recordEvent(9002, 'UserPromptSubmit', null, 20); // Running: not saved.
      recordEvent(9003, 'SessionStart', null, 30); // A new idle session: saved.
      vi.advanceTimersByTime(2500);
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>;
      expect(saved['9001']).toBe(5);
      expect(saved['9003']).toBe(30);
      expect(saved['9002']).toBeUndefined();
    } finally {
      for (const id of [9001, 9002, 9003]) forgetTurn(id);
      vi.useRealTimers();
    }
  });
});
