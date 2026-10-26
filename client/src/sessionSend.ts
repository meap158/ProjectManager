import type { AgentSession } from '../../shared/types';
import { api } from './api';

/**
 * Types a message into a session's CLI and submits it, after any images (each path its own paste,
 * which is how Claude Code and Codex recognise an image). Appends to what is already in the CLI's
 * input; never clears it. True when the session was down and the input was queued for its relaunch.
 */
export async function sendMessageToSession(
  session: Pick<AgentSession, 'id' | 'terminal'>,
  text: string,
  imagePaths: string[] = [],
): Promise<boolean> {
  const pty = session.terminal === 'pty';
  const paste = (value: string) =>
    pty ? `\x1b[200~${value.replace(/\r\n?/g, '\n')}\x1b[201~` : `${value} `;
  let queued = false;
  for (const path of imagePaths)
    queued = (await api.sendSessionInput(session.id, paste(path))).queued || queued;
  if (text) queued = (await api.sendSessionInput(session.id, paste(text))).queued || queued;
  queued = (await api.sendSessionInput(session.id, pty ? '\r' : '\n')).queued || queued;
  return queued;
}
