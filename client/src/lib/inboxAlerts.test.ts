import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../../../shared/types';
import { inboxItems } from '../components/InboxButton';
import { freshAlerts, inboxAlerts } from './inboxAlerts';

const session = (over: Partial<AgentSession>): AgentSession =>
  ({
    id: 1,
    projectId: 7,
    name: 'Fix login',
    status: 'running',
    tailState: 'idle',
    lastInputAt: '2026-11-05T10:00:00.000Z',
    lastOutputAt: '2026-11-05T10:00:05.000Z',
    ...over,
  }) as AgentSession;

describe('inboxAlerts (PM-429)', () => {
  it('notifies decisions, questions, failed restarts and orchestrator questions only', () => {
    const sessions = [
      session({ id: 1, tailState: 'input' }),
      session({ id: 2, question: 'Ship it to staging?' }),
      session({ id: 3, restartProgress: 'failed', lastRestartAt: '2026-11-05T09:00:00.000Z' }),
      session({ id: 4, usageLimit: { resetsAt: null } }),
      session({ id: 5 }), // finished reply: stays in the Inbox
      session({ id: 6, orchestratorId: 'trial', tailState: 'input' }),
      session({ id: 7, orchestratorId: 'trial', tailState: 'running' }),
    ];
    const alerts = inboxAlerts(
      inboxItems(sessions, Date.parse('2026-11-05T11:00:00.000Z')),
      sessions,
      new Map([[7, 'Sparkline']]),
    );
    expect(alerts.map((a) => a.path)).toEqual([
      '/workspace?open=1',
      '/workspace?open=2',
      '/workspace?open=3',
      '/orchestrators',
    ]);
    expect(alerts[0]!.title).toBe('Fix login needs your decision');
    expect(alerts[1]!.body).toBe('Sparkline: Ship it to staging?');
  });

  it('records what is already waiting on the first look, then shows each new one once', () => {
    const a = { key: 'a', title: 'A', body: '', path: '/' };
    const b = { key: 'b', title: 'B', body: '', path: '/' };
    const first = freshAlerts([a], null);
    expect(first).toEqual({ show: [], sent: ['a'] });
    const second = freshAlerts([a, b], first.sent);
    expect(second.show).toEqual([b]);
    expect(freshAlerts([a, b], second.sent).show).toEqual([]);
  });
});
