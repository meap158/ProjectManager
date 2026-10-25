import type { AgentSession } from '../../../shared/types';
import { api } from '../api';
import type { AttentionCommand } from '../components/BatchAttentionActions';
import { splitSessionInput } from './sessionInput';

/**
 * Sends one answer to a CLI: a keystroke, a line (pasted as one block in a terminal, then Enter),
 * or a usage-limit action. Shared by the batch processor (PM-165) and the Inbox (PM-261).
 * Resolves true when the input was queued for a session that is reconnecting.
 */
export async function sendAttentionCommand(
  target: AgentSession,
  cmd: AttentionCommand,
): Promise<boolean> {
  if (cmd.kind === 'auto-continue') {
    await api.setAutoContinue(target.id, true);
    return false;
  }
  if (cmd.kind === 'continue-now') {
    await api.continueSessionNow(target.id);
    return false;
  }
  if (cmd.kind === 'key') {
    const ack = await api.sendSessionInput(target.id, cmd.data);
    return ack.queued;
  }
  let queued = false;
  const data =
    target.terminal === 'pty' ? `\x1b[200~${cmd.text.replace(/\r\n?/g, '\n')}\x1b[201~` : cmd.text;
  for (const part of splitSessionInput(data)) {
    const ack = await api.sendSessionInput(target.id, part);
    queued ||= ack.queued;
  }
  const ack = await api.sendSessionInput(target.id, target.terminal === 'pty' ? '\r' : '\n');
  queued ||= ack.queued;
  return queued;
}
