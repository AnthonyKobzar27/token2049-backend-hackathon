// Payment watcher: unlocks jobs when the buyer's funds are locked, fails unpaid jobs, submits result hashes.
import type { ApiDeps } from '../domain/ports';
import type { HaasEvent, Job } from '../domain/types';
import { resultHash } from './hash';
import type { PaymentClient } from './payments';

export const POLL_MS = 15_000;

/** The string a purchaser sees as `result`, and the one whose hash we submit. */
export const resultString = (job: Job): string => JSON.stringify(job.result ?? { outcome: 'no_booking', summary: job.error ?? '' });

export function createWatcher(deps: ApiDeps, payments: PaymentClient | undefined, opts: { intervalMs?: number; now?: () => number } = {}) {
  const { jobs, store, bus } = deps;
  const now = opts.now ?? Date.now;
  const submitting = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  let polling = false;

  async function checkPayment(job: Job): Promise<void> {
    const p = job.payment;
    if (!p || !payments) return;
    const state = await payments.getPayment(p.blockchainIdentifier);
    if (state.fundsLocked) {
      store.updateJob(job.id, { payment: { ...p, paidAt: now() } });
      jobs.markPaid(job.id);
    } else if (now() > p.payByTime) {
      const failed = store.updateJob(job.id, { status: 'failed', error: 'payment not received before payByTime' });
      bus.emit({ type: 'job.updated', job: failed });
    }
  }

  async function submit(job: Job): Promise<void> {
    if (!payments || submitting.has(job.id)) return;
    submitting.add(job.id);
    try {
      const fresh = store.getJob(job.id) ?? job;
      const p = fresh.payment;
      if (fresh.status !== 'completed' || !p?.paidAt || p.resultSubmittedAt) return;
      const state = await payments.getPayment(p.blockchainIdentifier);
      if (!state.resultSubmitted) {
        await payments.submitResult(p.blockchainIdentifier, resultHash(resultString(fresh), p.identifierFromPurchaser));
      }
      store.updateJob(fresh.id, { payment: { ...(store.getJob(fresh.id)?.payment ?? p), resultSubmittedAt: now() } });
    } catch (err) {
      console.error(`[masumi] submit result for ${job.id} failed (will retry):`, (err as Error).message);
    } finally {
      submitting.delete(job.id);
    }
  }

  async function poll(): Promise<void> {
    if (!payments || polling) return;
    polling = true;
    try {
      for (const job of store.listJobs({ status: 'awaiting_payment', client: 'masumi' })) {
        if (!job.payment || job.payment.paidAt) continue;
        await checkPayment(job).catch((err) => console.error(`[masumi] payment check for ${job.id} failed:`, (err as Error).message));
      }
      for (const job of store.listJobs({ status: 'completed', client: 'masumi' })) {
        if (job.payment?.paidAt && !job.payment.resultSubmittedAt) await submit(job);
      }
    } finally {
      polling = false;
    }
  }

  const onEvent = (e: HaasEvent) => {
    if (e.type === 'job.updated' && e.job.client === 'masumi' && e.job.status === 'completed' && e.job.payment?.paidAt && !e.job.payment.resultSubmittedAt) {
      void submit(e.job);
    }
  };

  return {
    poll,
    start() {
      if (!payments || timer) return;
      unsubscribe = bus.on(onEvent);
      timer = setInterval(() => void poll(), opts.intervalMs ?? POLL_MS);
      timer.unref();
      void poll();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
