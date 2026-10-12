// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../../shared/types';
import { AgentWorkList, type WorkItem, type WorkKey } from './AgentWorkList';

afterEach(cleanup);

const mockSession = (id: number, name: string): AgentSession =>
  ({
    id,
    projectId: 1,
    name,
    providerId: 'opencode',
    command: ['opencode'],
    cwd: 'S:\\Vibe Coding\\Project',
    status: 'running',
    exitCode: null,
    desiredState: 'running',
    supervise: 1,
    restarts: 0,
    lastRestartAt: null,
    queuedInputBytes: 0,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    logBytes: 100,
    lastOutputAt: new Date().toISOString(),
    tailState: 'running',
    terminal: 'pty',
    cardId: null,
  }) as unknown as AgentSession;

it('navigates between CLI sessions using Ctrl+ArrowDown and Ctrl+ArrowUp', () => {
  const items: WorkItem[] = [
    { kind: 'session', item: mockSession(10, 'Session 10') },
    { kind: 'session', item: mockSession(20, 'Session 20') },
    { kind: 'session', item: mockSession(30, 'Session 30') },
  ];

  function TestHarness() {
    const [selected, setSelected] = useState<WorkKey | null>('session:10');
    return (
      <AgentWorkList
        items={items}
        selected={selected}
        onSelect={setSelected}
        now={Date.now()}
      />
    );
  }

  render(<TestHarness />);

  expect(screen.getByRole('button', { name: 'Show Session 10' }).getAttribute('aria-current')).toBe('true');

  // Press Ctrl+ArrowDown -> navigates to Session 20
  fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true });
  expect(screen.getByRole('button', { name: 'Show Session 20' }).getAttribute('aria-current')).toBe('true');

  // Press Ctrl+ArrowDown -> navigates to Session 30
  fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true });
  expect(screen.getByRole('button', { name: 'Show Session 30' }).getAttribute('aria-current')).toBe('true');

  // Press Ctrl+ArrowDown -> wraps to Session 10
  fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true });
  expect(screen.getByRole('button', { name: 'Show Session 10' }).getAttribute('aria-current')).toBe('true');

  // Press Ctrl+ArrowUp -> navigates back to Session 30
  fireEvent.keyDown(window, { key: 'ArrowUp', ctrlKey: true });
  expect(screen.getByRole('button', { name: 'Show Session 30' }).getAttribute('aria-current')).toBe('true');
});

it('uses onNavigate callback without toggling if provided', () => {
  const items: WorkItem[] = [
    { kind: 'session', item: mockSession(1, 'Session 1') },
    { kind: 'session', item: mockSession(2, 'Session 2') },
  ];

  const onSelect = vi.fn();
  const onNavigate = vi.fn();

  render(
    <AgentWorkList
      items={items}
      selected="session:1"
      onSelect={onSelect}
      onNavigate={onNavigate}
      now={Date.now()}
    />,
  );

  fireEvent.keyDown(window, { key: 'ArrowDown', ctrlKey: true });
  expect(onNavigate).toHaveBeenCalledWith('session:2');
  expect(onSelect).not.toHaveBeenCalled();
});
