import { open, stat } from 'node:fs/promises';
import type { ChatItem } from '../../shared/types.js';
import { readProviderTranscript } from './providerTranscripts.js';
import { findTranscript, parseClaudeLine, parseCodexLine, transcriptSource } from './transcript.js';

// PM-298: a session idle at its prompt whose last reply asks you something (in words, not a menu)
// needs you as much as one showing a menu. Found from the CLI's own transcript, which holds the
// reply as written; the screen wraps and redraws it.

/** Lines from the end of a reply that a question may be in: questions close a reply. */
const LAST_LINES = 2;

/** Phrases that ask you to act or answer. Kept narrow: a false "needs you" costs attention. */
const ASKS = [
  /\b(?:do|would|should|shall|can|could) (?:you|i|we)\b[^?]*\?/i,
  /\?\s*$/,
  /\btell me\b/i,
  /\bneeds? (?:your )?input\b/i,
  /\b(?:waiting|blocked) (?:on|for) (?:you|your)\b/i,
  /\byour (?:call|pick|decision|choice|go-ahead|approval|answer)\b/i,
  /\bsay ["“'][^"”']+["”'] (?:and|to|when)\b/i,
  /\breply (?:with|yes|no)\b/i,
];

/** Offers that don't wait on you ("say X if you want Y", "let me know if…"). */
const OFFERS = [/\bif you (?:want|like|prefer|'d like)\b/i, /\blet me know if\b/i];

/** Markdown and whitespace off, for showing a line on its own. */
const plain = (line: string) =>
  line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The question the end of a reply asks you, or null when it asks nothing. Only the last lines
 * count (outside code blocks): a question in the middle of a long report was answered by the
 * report itself.
 */
export function askedQuestion(reply: string): string | null {
  const prose = reply.replace(/```[\s\S]*?(?:```|$)/g, '');
  const lines = prose
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\s*>/.test(l))
    .slice(-LAST_LINES);
  for (let i = lines.length - 1; i >= 0; i--) {
    // The sentence that asks, not its whole paragraph: the ask usually closes a long one.
    const sentences = plain(lines[i]!).match(/[^.!?]+(?:[.!?]+|$)/g) ?? [];
    for (let j = sentences.length - 1; j >= 0; j--) {
      const sentence = sentences[j]!.trim();
      if (!sentence || OFFERS.some((p) => p.test(sentence))) continue;
      if (ASKS.some((p) => p.test(sentence))) return sentence.slice(0, 280);
    }
  }
  return null;
}

/** The newest assistant text after the last user message in a transcript, if any. */
export function lastReplyText(items: ChatItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === 'user') return null;
    if (item.kind === 'assistant' && item.text?.trim()) return item.text;
  }
  return null;
}

/** How much of a Claude/Codex transcript's end is read: the last reply, not the conversation. */
const TAIL_BYTES = 256 * 1024;

async function tailItems(file: string, size: number, providerId: string): Promise<ChatItem[]> {
  const from = Math.max(0, size - TAIL_BYTES);
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(size - from);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (from > 0) text = text.slice(text.indexOf('\n') + 1); // A partial first line.
    const parse = providerId === 'codex' ? parseCodexLine : (l: string) => parseClaudeLine(l);
    return text.split('\n').flatMap((line) => (line ? parse(line) : []));
  } catch {
    return [];
  } finally {
    await handle.close();
  }
}

export interface QuestionSource {
  providerId: string;
  resumeJson: string | null;
  codexHome?: string;
  cwd: string;
}

/**
 * The question each idle session's last reply asks, kept per session. `get` answers from memory
 * (the session list is built every few seconds) and starts at most one background read per
 * session when its log moved on; Claude and Codex transcripts are not even read while their size
 * is unchanged, so an idle session that only redraws its screen costs one stat.
 */
export class QuestionCache {
  private entries = new Map<
    number,
    { version: string; question: string | null; file?: string; size?: number }
  >();
  private reading = new Set<number>();

  constructor(private source: (id: number) => QuestionSource | null) {}

  get(id: number, version: string): string | null {
    const entry = this.entries.get(id);
    if (entry?.version !== version && !this.reading.has(id)) void this.refresh(id, version);
    return entry?.question ?? null;
  }

  forget(keep: ReadonlySet<number>): void {
    for (const id of this.entries.keys()) if (!keep.has(id)) this.entries.delete(id);
  }

  private async refresh(id: number, version: string): Promise<void> {
    this.reading.add(id);
    const previous = this.entries.get(id);
    try {
      const src = this.source(id);
      if (!src) return;
      const files = transcriptSource(src.providerId, src.resumeJson, src.codexHome);
      if (files) {
        const file = await findTranscript(files);
        if (!file) return;
        const { size } = await stat(file);
        if (previous?.file === file && previous.size === size) {
          this.entries.set(id, { ...previous, version });
          return;
        }
        const reply = lastReplyText(await tailItems(file, size, src.providerId));
        this.entries.set(id, {
          version,
          file,
          size,
          question: reply ? askedQuestion(reply) : null,
        });
        return;
      }
      if (['opencode', 'grok', 'antigravity'].includes(src.providerId)) {
        const { items } = await readProviderTranscript(src.providerId, src.resumeJson, src.cwd);
        const reply = lastReplyText(items);
        this.entries.set(id, { version, question: reply ? askedQuestion(reply) : null });
        return;
      }
      // Shells and custom commands keep no transcript: menus on screen still count (tailState).
      this.entries.set(id, { version, question: null });
    } catch {
      // Unreadable now: try again when the log moves on.
    } finally {
      this.reading.delete(id);
    }
  }
}
