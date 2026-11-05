import type { ChatItem, SessionTranscript } from '../../shared/types.js';
import { readProviderTranscript } from './providerTranscripts.js';
import { AgentError, type AgentSupervisor } from './supervisor.js';
import { findTranscript, readTranscript, transcriptSource } from './transcript.js';

/**
 * A session's conversation from its CLI's own transcript, read from `offset` (the chat view and
 * the orchestrator's worker_reply share it). Read-only.
 */
export async function readSessionTranscript(
  supervisor: AgentSupervisor,
  id: number,
  offset?: number,
): Promise<SessionTranscript> {
  const resume = supervisor.sessionResume(id);
  if (!resume) throw new AgentError(404, 'Session not found');
  if (
    resume.providerId === 'opencode' ||
    resume.providerId === 'grok' ||
    resume.providerId === 'antigravity'
  ) {
    const session = supervisor.getSession(id);
    if (!session) throw new AgentError(404, 'Session not found');
    let resumeJson = resume.resumeJson;
    const running = session.status === 'running';
    // A new OpenCode / Antigravity session: its conversation gets pinned once it exists.
    if (!resumeJson && running && resume.providerId !== 'grok') {
      await supervisor.pinConversation(id);
      resumeJson = supervisor.sessionResume(id)?.resumeJson ?? null;
      // Nothing sent yet: an empty chat, not "started before pinning" (the first message
      // starts the conversation, and the next poll finds it).
      if (!resumeJson) return { supported: true, items: [], next: 0, reset: false };
    }
    return readProviderTranscript(resume.providerId, resumeJson, session.cwd, offset);
  }
  const source = transcriptSource(resume.providerId, resume.resumeJson, resume.codexHome);
  const file = source ? await findTranscript(source) : null;
  if (!file) return { supported: !!source, items: [], next: 0, reset: false };
  return { supported: true, ...(await readTranscript(file, resume.providerId, offset)) };
}

/**
 * The session's newest reply: the assistant text written after the last user message, or null
 * while it has not answered yet (or its CLI keeps no readable transcript).
 */
export function lastReply(items: readonly ChatItem[]): { text: string; at: string | null } | null {
  const parts: string[] = [];
  let at: string | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === 'user') break;
    if (item.kind === 'assistant' && item.text?.trim()) {
      parts.unshift(item.text.trim());
      at ??= item.at ?? null;
    }
  }
  return parts.length ? { text: parts.join('\n\n'), at } : null;
}
