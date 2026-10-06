import type { AgentSession } from '../../../shared/types';
import { PlayIcon, StopIcon } from './icons';

/**
 * Start / Stop for a session row. The two look different at a glance (owner request PM-29): a
 * green play triangle to start, a red square to stop, plus the word, never colour alone.
 */
export function SessionToggle({
  session,
  onStart,
  onStop,
}: {
  session: AgentSession;
  onStart: () => void;
  onStop: () => void;
}) {
  return session.status === 'running' ? (
    <button
      type="button"
      className="btn btn-sm session-toggle stop"
      title="Stop the process (it won't relaunch until you start it)"
      onClick={onStop}
    >
      <StopIcon size={11} />
      Stop
    </button>
  ) : (
    <button
      type="button"
      className="btn btn-sm session-toggle start"
      title={session.resumeSupported ? 'Start again, resuming the conversation' : 'Start again'}
      onClick={onStart}
    >
      <PlayIcon size={11} />
      Start
    </button>
  );
}
