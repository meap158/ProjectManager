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
  },
}));
vi.mock('./OrchestratorTerminal', () => ({
  OrchestratorTerminal: ({ session }: { session: AgentSession }) => (
    <div role="region" aria-label={session.name}>
      Inline terminal {session.id}
    </div>
  ),
}));
afterEach(cleanup);
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
