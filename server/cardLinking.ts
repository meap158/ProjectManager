import {
  CARD_LINK_OUTBOX,
  cardLinkingKey,
  type CardLinkEvent,
  type CardLinkOptions,
} from '../shared/cardLinking.js';
import type { OrchestratorState } from '../shared/orchestrator.js';
import type { Db } from './db.js';
import { getCard, getProjectRow, getSetting, setSetting } from './store.js';
import { githubRepository } from './analysis/issueRefs.js';
import { originUrl } from './analysis/git.js';
import { ghAccountSettingKey, resolveGhIdentity } from './ghAccount.js';
import { run } from './analysis/exec.js';

export function linkedGitHubTarget(value: string): { repository: string; number: string } | null {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/([1-9]\d*)\/?$/i.exec(
      value,
    );
  return match ? { repository: `${match[1]}/${match[2]}`.toLowerCase(), number: match[3]! } : null;
}

export function writeBackAuthorized(db: Db, projectId: number): boolean {
  return (
    getSetting<CardLinkOptions>(db, cardLinkingKey(projectId))?.writeBack === true &&
    (getSetting<OrchestratorState>(db, 'master-orchestrators')?.instances ?? []).some(
      (instance) =>
        instance.enabled &&
        instance.strategy !== 'observe' &&
        instance.gitAutonomy === true &&
        (!instance.projectIds.length || instance.projectIds.includes(projectId)),
    )
  );
}

interface Rate {
  attempts: number[];
}
/** Durable bounded outbox; reserves before sending and never retries uncertain delivery. */
export class CardLinkWriteBack {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private cursor = 0;
  constructor(private db: Db) {}
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), 15_000);
    this.timer.unref();
    void this.tick();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.process()
      .catch(() => {
        console.error('[card-linking] Could not process card write-back');
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  private remove(id: string) {
    setSetting(
      this.db,
      CARD_LINK_OUTBOX,
      (getSetting<CardLinkEvent[]>(this.db, CARD_LINK_OUTBOX) ?? []).filter((e) => e.id !== id),
    );
  }
  private valid(event: CardLinkEvent) {
    const card = getCard(this.db, event.cardId);
    return (
      card &&
      card.projectId === event.projectId &&
      card.status === event.status &&
      card.issueUrl === event.url &&
      writeBackAuthorized(this.db, event.projectId) &&
      Date.now() - event.at < 24 * 60 * 60_000
    );
  }
  private async process() {
    const events = getSetting<CardLinkEvent[]>(this.db, CARD_LINK_OUTBOX) ?? [];
    const offset = this.cursor % Math.max(1, events.length);
    this.cursor = offset + 20;
    // A throttled project must not keep every other project behind its pending events.
    const batch = [...events.slice(offset), ...events.slice(0, offset)].slice(0, 20);
    for (const event of batch) {
      if (this.stopped) return;
      const target = linkedGitHubTarget(event.url);
      const project = getProjectRow(this.db, event.projectId);
      if (!target || !project || !this.valid(event)) {
        this.remove(event.id);
        continue;
      }
      const receipt = `card-link-receipt:${event.cardId}:${event.status}`;
      const last = getSetting<number>(this.db, receipt);
      if (last && Date.now() - last < 24 * 60 * 60_000) {
        this.remove(event.id);
        continue;
      }
      const rateKey = `card-link-rate:${event.projectId}`;
      const attempts = (getSetting<Rate>(this.db, rateKey)?.attempts ?? []).filter(
        (at) => Date.now() - at < 60 * 60_000,
      );
      if (attempts.length >= 10 || (attempts.length && Date.now() - attempts.at(-1)! < 60_000))
        continue;
      try {
        const remote = await originUrl(project.path);
        const repository =
          remote && /^(?:https:\/\/github\.com\/|git@github\.com:)/i.test(remote)
            ? githubRepository(remote)
            : null;
        if (repository !== target.repository) {
          this.remove(event.id);
          continue;
        }
        const identity = await resolveGhIdentity(
          project.path,
          getSetting<string>(this.db, ghAccountSettingKey(project.id)) ?? null,
        );
        const owner = target.repository.split('/')[0]!;
        if (
          identity.account.owner?.toLowerCase() !== owner ||
          identity.account.login?.toLowerCase() !== owner
        ) {
          this.remove(event.id);
          continue;
        }
        // Verify the effective token, including inherited GH_TOKEN, rather than trusting gh's active label.
        const options = { cwd: project.path, env: identity.env, timeoutMs: 20_000 };
        const user = await run(
          'gh',
          ['api', '--hostname', 'github.com', 'user', '--jq', '.login'],
          options,
        );
        if (user.stdout.trim().toLowerCase() !== owner || this.stopped || !this.valid(event)) {
          this.remove(event.id);
          continue;
        }
        const card = getCard(this.db, event.cardId)!;
        const commit = /^[a-f0-9]{7,40}$/i.test(card.linkedCommit ?? '')
          ? ` Commit: ${card.linkedCommit}.`
          : '';
        const body = `${card.key} moved to ${event.status === 'review' ? 'Review' : 'Done'}.${commit}`;
        // A lost response must not result in another comment after restart.
        this.remove(event.id);
        setSetting(this.db, receipt, Date.now());
        setSetting(this.db, rateKey, { attempts: [...attempts, Date.now()] });
        setSetting(this.db, `card-link-result:${project.id}`, {
          at: Date.now(),
          card: card.key,
          status: 'delivery uncertain',
        });
        await run(
          'gh',
          [
            'api',
            '--hostname',
            'github.com',
            '--method',
            'POST',
            `repos/${target.repository}/issues/${target.number}/comments`,
            '--raw-field',
            `body=${body}`,
          ],
          options,
        );
        setSetting(this.db, `card-link-result:${project.id}`, {
          at: Date.now(),
          card: card.key,
          status: 'sent',
        });
      } catch {
        this.remove(event.id);
        // Never expose token-bearing gh output in logs or API results.
        console.error('[card-linking] Write-back failed; automatic retry suppressed');
      }
    }
  }
}
