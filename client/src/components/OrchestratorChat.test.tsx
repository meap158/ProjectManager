// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { OrchestratorConfig } from '../../../shared/orchestrator';
import type { AgentSession } from '../../../shared/types';
import { OrchestratorChat } from './OrchestratorChat';
import { api } from '../api';
vi.mock('../api', () => ({
  api: {
    openOrchestratorChat: vi.fn(async () => ({ id: 41, name: 'Master chat', status: 'running' })),
    checkOrchestrator: vi.fn(),
    getOrchestratorChatWork: vi.fn(async () => null),
  },
}));
vi.mock('./OrchestratorTerminal', () => ({
  OrchestratorTerminal: ({
    session,
    onSessionChanged,
  }: {
    session: AgentSession;
    onSessionChanged?: (session: AgentSession) => void;
  }) => (
    <div role="region" aria-label={session.name}>
      Inline terminal {session.id}
      <button onClick={() => onSessionChanged?.({ ...session, status: 'killed' })}>
        Simulate stopped response
      </button>
    </div>
  ),
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it('opens and hides master chat inline without navigating to Agents or stopping it', async () => {
  const changed = vi.fn();
  render(
    <OrchestratorChat
      instance={{ id: 'master', name: 'Master' } as OrchestratorConfig}
      session={null}
      disabled={false}
      onChanged={changed}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
  expect(await screen.findByRole('region', { name: 'Master chat' })).toBeDefined();
  expect(api.openOrchestratorChat).toHaveBeenCalledWith('master');
  expect(changed).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Hide chat' }));
  expect(screen.queryByRole('region')).toBeNull();
  expect(screen.queryByRole('link')).toBeNull();
});

it('unlocks agent selection immediately after the stopped response', async () => {
  const current = {
    id: 41,
    name: 'Master chat',
    providerId: 'codex',
    status: 'running',
  } as AgentSession;
  vi.mocked(api.openOrchestratorChat).mockResolvedValueOnce(current);
  render(
    <OrchestratorChat
      instance={
        { id: 'master', name: 'Master', providers: ['codex', 'claude'] } as OrchestratorConfig
      }
      session={current}
      disabled={false}
      onChanged={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Simulate stopped response' }));
  fireEvent.click(screen.getByRole('button', { name: /Orchestrator chat agent/ }));
  expect(
    screen.getByRole('option', { name: /Claude Code/ }).querySelector('button')!.disabled,
  ).toBe(false);
  expect(screen.getByText(/Stopped/)).toBeDefined();
});

it('explains why another agent cannot replace a running chat', () => {
  render(
    <OrchestratorChat
      instance={
        { id: 'master', name: 'Master', providers: ['codex', 'claude'] } as OrchestratorConfig
      }
      session={{ id: 1, providerId: 'codex', status: 'running' } as AgentSession}
      disabled={false}
      onChanged={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Orchestrator chat agent/ }));
  const option = screen.getByRole('option', { name: /Claude Code/ });
  expect(option.getAttribute('aria-disabled')).toBe('true');
  expect(option.textContent).toContain('Stop current chat first');
  expect(option.querySelector('button')!.disabled).toBe(true);
});

it('offers only configured chat agents and opens the chosen provider', async () => {
  render(
    <OrchestratorChat
      instance={
        {
          id: 'master',
          name: 'Master',
          providers: ['codex', 'claude', 'grok'],
        } as OrchestratorConfig
      }
      session={{ id: 1, providerId: 'codex', status: 'killed' } as AgentSession}
      disabled={false}
      onChanged={() => {}}
    />,
  );
  const selector = screen.getByRole('button', { name: /Orchestrator chat agent/ });
  fireEvent.click(selector);
  expect(screen.getAllByRole('option')).toHaveLength(2);
  fireEvent.click(screen.getByRole('option', { name: /Claude Code/ }).querySelector('button')!);
  expect(await screen.findByRole('region', { name: 'Master chat' })).toBeDefined();
  expect(api.openOrchestratorChat).toHaveBeenLastCalledWith('master', 'claude');
});

it('persists expanded chat state across unmounting and remounting (PM-163)', async () => {
  const current = {
    id: 41,
    name: 'Master chat',
    providerId: 'codex',
    status: 'running',
  } as AgentSession;
  vi.mocked(api.openOrchestratorChat).mockResolvedValueOnce(current);
  const { unmount } = render(
    <OrchestratorChat
      instance={{ id: 'master', name: 'Master' } as OrchestratorConfig}
      session={current}
      disabled={false}
      onChanged={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
  expect(await screen.findByRole('region', { name: 'Master chat' })).toBeDefined();

  unmount();

  render(
    <OrchestratorChat
      instance={{ id: 'master', name: 'Master' } as OrchestratorConfig}
      session={current}
      disabled={false}
      onChanged={() => {}}
    />,
  );
  expect(screen.getByRole('region', { name: 'Master chat' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Hide chat' })).toBeDefined();
});

it('sends dashboard attention checks to this chat (PM-172)', async () => {
  vi.mocked(api.checkOrchestrator).mockResolvedValueOnce({
    id: 99,
    status: 'running',
  } as AgentSession);
  render(
    <OrchestratorChat
      instance={{ id: 'master', name: 'Master' } as OrchestratorConfig}
      session={null}
      disabled={false}
      onChanged={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Needs attention' }));
  expect(await screen.findByRole('status')).toBeDefined();
  expect(api.checkOrchestrator).toHaveBeenLastCalledWith('master', 'attention');
});

it('quick-processes one kind of dashboard alert (PM-184)', async () => {
  vi.mocked(api.checkOrchestrator).mockResolvedValueOnce({
    id: 99,
    status: 'running',
  } as AgentSession);
  render(
    <OrchestratorChat
      instance={{ id: 'master', name: 'Master' } as OrchestratorConfig}
      session={null}
      disabled={false}
      onChanged={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Unpushed' }));
  expect(await screen.findByRole('status')).toBeDefined();
  expect(api.checkOrchestrator).toHaveBeenLastCalledWith('master', 'attention', ['Unpushed']);
});
