// How workers hear about bounties. One small interface so new channels (iMessage, SMS, push)
// slot in without touching the board: implement WorkerNotifier and add it to the composite.

import { esc } from '../channels/format';
import type { Bounty, Worker } from './types';

export type WorkerNoticeKind =
  /** A new bounty is offered to this worker. */
  | 'offer'
  /** This worker's claim succeeded. */
  | 'claimed'
  /** Someone else claimed a bounty this worker was offered. */
  | 'taken'
  /** The submission needs changes. */
  | 'revision'
  /** The submission was accepted and the reward paid. */
  | 'paid'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  /** A message from the agent about the task. */
  | 'message';

export interface WorkerNotice {
  kind: WorkerNoticeKind;
  bounty: Bounty;
  /** Plain text, ready to send. */
  text: string;
  /** The worker's own page for this bounty. */
  url?: string;
}

export interface WorkerNotifier {
  /** e.g. "telegram", "console", "imessage". */
  readonly channel: string;
  /** True when this channel has a way to reach the worker. */
  canReach(worker: Worker): boolean;
  notify(worker: Worker, notice: WorkerNotice): Promise<void>;
}

/** Logs notices; always reachable. Useful in demos and as the last resort. */
export function createConsoleNotifier(log: (line: string) => void = (l) => console.log(l)): WorkerNotifier & { sent: { worker: string; notice: WorkerNotice }[] } {
  const sent: { worker: string; notice: WorkerNotice }[] = [];
  return {
    channel: 'console',
    sent,
    canReach: () => true,
    async notify(worker, notice) {
      sent.push({ worker: worker.id, notice });
      log(`[bounty → ${worker.name}] ${notice.text}${notice.url ? `\n  ${notice.url}` : ''}`);
    },
  };
}

/**
 * Telegram: sends (HTML) through whatever bot is running. `send` is bound when the bot starts,
 * so the notifier can be created before the bot (until then it reports unreachable).
 */
export function createTelegramWorkerNotifier(): WorkerNotifier & { bind(send: ((chatId: string, text: string) => Promise<unknown>) | undefined): void } {
  let send: ((chatId: string, text: string) => Promise<unknown>) | undefined;
  return {
    channel: 'telegram',
    bind(fn) {
      send = fn;
    },
    canReach: (w) => Boolean(send && w.contact.telegramId),
    async notify(worker, notice) {
      if (!send || !worker.contact.telegramId) return;
      const tail = notice.kind === 'offer' ? `\n\nReply /claim ${notice.bounty.code} to take it.` : notice.kind === 'claimed' || notice.kind === 'revision' ? `\n\nWhen done: /submit ${notice.bounty.code} ${submitExample(notice.bounty)}` : '';
      await send(worker.contact.telegramId, esc(`${notice.text}${notice.url ? `\n${notice.url}` : ''}${tail}`));
    },
  };
}

export function submitExample(b: Bounty): string {
  const sample: Record<string, string> = { date: '2026-10-08', time: '15:00', reference: '88213', number: '1', url: 'https://…' };
  return b.spec.fields.map((x) => `${x.key}=${sample[x.key] ?? sample[x.type] ?? '…'}`).join(' ') + ' | notes';
}

/** Sends through every channel that can reach the worker; falls back to the first channel that always can. */
export function createCompositeNotifier(notifiers: WorkerNotifier[]): WorkerNotifier {
  return {
    channel: notifiers.map((n) => n.channel).join('+'),
    canReach: (w) => notifiers.some((n) => n.canReach(w)),
    async notify(worker, notice) {
      const reach = notifiers.filter((n) => n.canReach(worker));
      await Promise.all(
        reach.map((n) =>
          n.notify(worker, notice).catch((err) => console.error(`[bounty] ${n.channel} notify ${worker.id} failed:`, err instanceof Error ? err.message : err)),
        ),
      );
    },
  };
}
