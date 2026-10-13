import { useState } from 'react';
import { PROVIDER_LABELS, ProviderIcon } from './icons';
import { Dropdown } from './Dropdown';
import { OrchestratorTerminal } from './OrchestratorTerminal';
import { api } from '../api';
import type { AgentSession } from '../../../shared/types';
import type { OrchestratorConfig } from '../../../shared/orchestrator';
import './orchestrator-chat.css';

type Focus = 'all' | 'todo' | 'in_progress' | 'review';
const CHECKS: { focus: Focus; label: string; title: string }[] = [
  {
    focus: 'all',
    label: 'Everything pending',
    title: 'Check progress, review evidence and work through To do, then report back',
  },
  { focus: 'todo', label: 'To do', title: 'Work through the To do tasks within worker limits' },
  {
    focus: 'in_progress',
    label: 'In progress',
    title: 'Check progress on In progress tasks and update their status',
  },
  { focus: 'review', label: 'Review', title: 'Check Review tasks: what is ready to accept' },
];

function chatState(session: AgentSession | null): string {
  if (!session) return 'Not started yet';
  if (session.status !== 'running') return 'Stopped · reopening continues the conversation';
  if (session.tailState === 'input') return 'Asking you something';
  if (session.tailState === 'running') return 'Working';
  return 'Waiting for you';
}

/**
 * An orchestrator's own chat CLI (PM-89): open it to talk to the orchestrator, or ask it for a one-time
 * check on pending work. It knows the orchestrator's projects and acts through scoped board tools.
 */
export function OrchestratorChat({
  instance,
  session,
  disabled,
  onChanged,
}: {
  instance: OrchestratorConfig;
  /** The orchestrator's newest chat session, if any. */
  session: AgentSession | null;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [opened, setOpened] = useState<AgentSession | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<{ sessionId: number; label: string } | null>(null);
  const busy = disabled || working !== null;
  const run = async (key: string, action: () => Promise<void>) => {
    setWorking(key);
    setError('');
    setSent(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  };
  const open = (providerId?: string) =>
    run('open', async () => {
      const opened = providerId
        ? await api.openOrchestratorChat(instance.id, providerId)
        : await api.openOrchestratorChat(instance.id);
      setOpened(opened);
      setTerminalOpen(true);
      onChanged();
    });
  const check = (focus: Focus, label: string) =>
    run(focus, async () => {
      const chat = await api.checkOrchestrator(instance.id, focus);
      setSent({ sessionId: chat.id, label });
      setOpened(chat);
      onChanged();
    });
  const activeSession = opened && session?.id === opened.id ? session : (opened ?? session);
  return (
    <div className="orchestrator-chat" aria-label={`${instance.name} chat`}>
      <div className="orchestrator-chat-head">
        <div>
          <span className="orchestrator-subheading">Ask this orchestrator</span>
          <p className="faint">
            Chat with it in its own terminal: it knows these projects and can follow up on tasks,
            check progress, move cards and start workers within its limits.
          </p>
        </div>
        <div className="orchestrator-chat-open">
          <Dropdown
            label="Orchestrator chat agent"
            disabled={busy}
            value={
              activeSession?.providerId ??
              instance.providers?.find((p) =>
                ['claude', 'codex', 'opencode', 'antigravity'].includes(p),
              ) ??
              ''
            }
            onChange={(provider) => void open(provider)}
            options={(instance.providers ?? [])
              .filter((p) => ['claude', 'codex', 'opencode', 'antigravity'].includes(p))
              .map((provider) => ({
                value: provider,
                icon: <ProviderIcon id={provider} size={14} />,
                disabled:
                  activeSession?.status === 'running' && provider !== activeSession.providerId,
                hint:
                  activeSession?.status === 'running' && provider !== activeSession.providerId
                    ? 'Stop current chat first'
                    : undefined,
                label: PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS] ?? provider,
                sub: 'Open chat with this agent',
              }))}
          />
          <span
            className={`orchestrator-chat-state${activeSession?.status === 'running' ? ' is-live' : ''}`}
          >
            {chatState(activeSession)}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={() => (terminalOpen ? setTerminalOpen(false) : void open())}
          >
            {working === 'open'
              ? 'Opening…'
              : terminalOpen
                ? 'Hide chat'
                : session
                  ? 'Open chat'
                  : 'Start chat'}
          </button>
        </div>
      </div>
      <div className="orchestrator-chat-checks" role="group" aria-label="One-time check">
        <span className="faint">Ask it to check:</span>
        {CHECKS.map((c) => (
          <button
            key={c.focus}
            type="button"
            className="btn btn-sm"
            disabled={
              busy || activeSession?.tailState === 'running' || activeSession?.tailState === 'input'
            }
            title={c.title}
            onClick={() => void check(c.focus, c.label)}
          >
            {working === c.focus ? 'Sending…' : c.label}
          </button>
        ))}
      </div>
      {sent && (
        <p role="status" className="orchestrator-chat-sent">
          Asked it to check{' '}
          {sent.label === 'Everything pending' ? 'everything pending' : sent.label}.{' '}
          <button type="button" className="btn btn-sm" onClick={() => setTerminalOpen(true)}>
            Watch it work
          </button>
        </p>
      )}
      {terminalOpen && activeSession && (
        <OrchestratorTerminal session={activeSession} onChanged={onChanged} />
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
