// Payment watcher for MIP-003 jobs. One pass, in order of the escrow's life:
//   awaiting_payment + FundsLocked           -> markPaid (routing starts)
//   awaiting_payment past payByTime          -> failed
//   completed, paid, no result hash yet      -> POST /payment/submit-result (MIP-004 hash of the /status result)
//   result submitted, past unlockTime        -> wait for the payment service's automatic withdrawal and record the
//                                               collection tx hash on job.payment (collectionTxHash, collectedAt)
// The result window keeps running while a human answers the check-in; a warning is logged when a paid job is
// still open 30 minutes before submitResultTime (after that the buyer can claim a refund).
import type { ApiDeps } from '../domain/ports';
import type { HaasEvent, Job, JobPayment } from '../domain/types';
import { resultHash } from './hash';
import type { PaymentClient } from './payments';

export const POLL_MS = 15_000;
const WARN_BEFORE_MS = 30 * 60_000;
/** Stop waiting for collection this long after the dispute window closes. */
const COLLECTION_GIVE_UP_MS = 24 * 3_600_000;

/** The string a purchaser sees as `result`, and the one whose hash we submit. */
export const resultString = (job: Job): string => JSON.stringify(job.result ?? { outcome: 'no_booking', summary: job.error ?? '' });

export function createWatcher(deps: ApiDeps, payments: PaymentClient | undefined, opts: { intervalMs?: number; now?: () => number } = {}) {
  const { jobs, store, bus } = deps;
  const now = opts.now ?? Date.now;
  const submitting = new Set<string>();
  const warned = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  let polling = false;

  const patchPayment = (id: string, patch: Partial<JobPayment>) => {
    const cur = store.getJob(id)?.payment;
    if (cur) store.updateJob(id, { payment: { ...cur, ...patch } });
  };

  async function checkPayment(job: Job): Promise<void> {
    const p = job.payment;
    if (!p || !payments) return;
    const state = await payments.getPayment(p.blockchainIdentifier);
    if (state.fundsLocked) {
      store.updateJob(job.id, { payment: { ...p, paidAt: now(), onChainState: 'FundsLocked' } });
      console.log(`[masumi] job ${job.id}: funds locked for ${p.blockchainIdentifier.slice(0, 24)}...`);
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
      if (now() > p.submitResultTime) {
        console.error(`[masumi] job ${fresh.id}: submitResultTime passed before the result was ready; the buyer can claim a refund`);
        patchPayment(fresh.id, { resultSubmittedAt: now(), onChainState: 'ResultDeadlineMissed' });
        return;
      }
      // MIP-004 over exactly the result /status shows, so the buyer can check it. A QA-verified result
      // carries verifiedResult.hash, the hash its escrow release was bound to, so this hash commits to it.
      const hash = resultHash(resultString(fresh), p.identifierFromPurchaser);
      const state = await payments.getPayment(p.blockchainIdentifier);
      if (!state.resultSubmitted) await payments.submitResult(p.blockchainIdentifier, hash);
      patchPayment(fresh.id, { resultSubmittedAt: now(), resultHash: hash });
      console.log(`[masumi] job ${fresh.id}: result hash ${hash} submitted; collection after ${new Date(p.unlockTime).toISOString()}`);
    } catch (err) {
      console.error(`[masumi] submit result for ${job.id} failed (will retry):`, (err as Error).message);
    } finally {
      submitting.delete(job.id);
    }
  }

  /** After unlockTime the payment service withdraws on its own; we record the confirmed transaction. */
  async function checkCollection(job: Job): Promise<void> {
    const p = job.payment;
    if (!payments || !p?.resultSubmittedAt || p.collectedAt || !p.resultHash) return;
    if (now() < p.unlockTime) return;
    if (now() > p.externalDisputeUnlockTime + COLLECTION_GIVE_UP_MS) {
      if (!warned.has(`collect:${job.id}`)) {
        warned.add(`collect:${job.id}`);
        console.error(`[masumi] job ${job.id}: no withdrawal seen a day after the dispute window; check the payment service (AUTO_WITHDRAW_PAYMENTS)`);
      }
      return;
    }
    const state = await payments.getPayment(p.blockchainIdentifier);
    if (state.onChainState && state.onChainState !== p.onChainState) patchPayment(job.id, { onChainState: state.onChainState });
    if (state.withdrawn && state.collectionTxHash) {
      patchPayment(job.id, { collectedAt: now(), collectionTxHash: state.collectionTxHash, onChainState: state.onChainState ?? 'Withdrawn' });
      console.log(`[masumi] job ${job.id}: collected, tx ${state.collectionTxHash} (https://preprod.cardanoscan.io/transaction/${state.collectionTxHash})`);
    }
  }

  function warnDeadline(job: Job): void {
    const p = job.payment;
    if (!p?.paidAt || warned.has(job.id)) return;
    if (p.submitResultTime - now() < WARN_BEFORE_MS) {
      warned.add(job.id);
      console.warn(`[masumi] job ${job.id} is ${job.status} and its result is due ${new Date(p.submitResultTime).toISOString()}; raise MASUMI_RESULT_WINDOW_MIN if this happens often`);
    }
  }

  async function poll(): Promise<void> {
    if (!payments || polling) return;
    polling = true;
    const guard = (id: string, what: string) => (err: unknown) => console.error(`[masumi] ${what} for ${id} failed:`, (err as Error).message);
    try {
      for (const job of store.listJobs({ status: 'awaiting_payment', client: 'masumi' })) {
        if (!job.payment || job.payment.paidAt) continue;
        await checkPayment(job).catch(guard(job.id, 'payment check'));
      }
      for (const status of ['running', 'awaiting_input'] as const) {
        for (const job of store.listJobs({ status, client: 'masumi' })) warnDeadline(job);
      }
      for (const job of store.listJobs({ status: 'completed', client: 'masumi' })) {
        if (job.payment?.paidAt && !job.payment.resultSubmittedAt) await submit(job);
        else if (job.payment?.resultSubmittedAt && !job.payment.collectedAt) await checkCollection(job).catch(guard(job.id, 'collection check'));
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
