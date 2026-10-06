// ReputationMinter: turns a completed (and, when available, QA-verified) booking into an on-chain
// reputation update. Listens on the event bus, never blocks the booking flow, retries with backoff,
// and is idempotent per booking (a task per booking id, plus a check of the chain before writing).

import { createHash } from 'node:crypto';
import type { EventBus, Store } from '../domain/ports';
import type { Booking, HaasEvent } from '../domain/types';
import { canonicalJson, resultHash } from '../masumi/hash';
import { resultString } from '../masumi/watcher';
import { applyJob, cip20Message, credentialDatumFields, receiptAssetName, receiptMetadata, reputationFromFields } from './cip68';
import type { IdentityRegistry } from './registry';
import type { JobReceipt, VerificationEvent } from './types';
import { isPaymentCollectedEvent, isVerificationEvent } from './types';

export type MintTaskStatus = 'waiting_verification' | 'waiting_wallet' | 'queued' | 'done' | 'rejected' | 'failed';

export interface MintTask {
  bookingId: string;
  workerId: string;
  jobId: string;
  priceUsd: number;
  status: MintTaskStatus;
  attempts: number;
  /** Not before this time (backoff, or end of the verification grace period). */
  nextAt: number;
  createdAt: number;
  error?: string;
  txHash?: string;
  receiptUnit?: string;
}

export interface MinterOptions {
  /** How long to wait for a QA verdict before minting without one. */
  verifyGraceMs?: number;
  /** Never mint without a passing QA verdict. */
  requireVerification?: boolean;
  /** Mint a CIP-25 job receipt NFT to the worker with each update. */
  receipts?: boolean;
  /** Issue the credential on the first completed job when the worker has a wallet but none yet. */
  autoIssue?: boolean;
  maxAttempts?: number;
  baseBackoffMs?: number;
  intervalMs?: number;
  confirmTimeoutMs?: number;
  now?: () => number;
}

export interface ReputationMinter {
  start(): void;
  stop(): void;
  /** Processes due tasks. Safe to call any time; concurrent calls are coalesced. */
  tick(): Promise<void>;
  /** For flows that complete work outside the booking service (e.g. a bounty board). */
  recordCompletion(input: { bookingId: string; workerId: string; jobId: string; priceUsd: number }): MintTask;
  recordVerification(v: Omit<VerificationEvent, 'type'>): void;
  recordPayment(jobId: string, txHash: string): void;
  rate(bookingId: string, rating: number): void;
  task(bookingId: string): MintTask | undefined;
  tasks(filter?: { workerId?: string; open?: boolean }): MintTask[];
}

const K = {
  index: 'identity:tasks',
  task: (b: string) => `identity:task:${b}`,
  qa: (b: string) => `identity:qa:${b}`,
  pay: (j: string) => `identity:paytx:${j}`,
  rating: (b: string) => `identity:rating:${b}`,
};
const OPEN: MintTaskStatus[] = ['waiting_verification', 'waiting_wallet', 'queued'];

export function createReputationMinter(deps: { store: Store; bus: EventBus; registry: IdentityRegistry }, opts: MinterOptions = {}): ReputationMinter {
  const { store, bus, registry } = deps;
  const chain = registry.chain;
  const now = opts.now ?? Date.now;
  const grace = opts.verifyGraceMs ?? 10 * 60_000;
  const maxAttempts = opts.maxAttempts ?? 8;
  const baseBackoff = opts.baseBackoffMs ?? 30_000;
  const receiptsOn = opts.receipts ?? true;
  const autoIssue = opts.autoIssue ?? true;
  const confirmTimeout = opts.confirmTimeoutMs ?? 240_000;
  const busy = new Set<string>();
  let ticking: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;

  const getJson = <T>(k: string): T | undefined => {
    const v = store.getKv(k);
    if (!v) return undefined;
    try {
      return JSON.parse(v) as T;
    } catch {
      return undefined;
    }
  };
  const setJson = (k: string, v: unknown) => store.setKv(k, JSON.stringify(v));
  const index = (): string[] => getJson<string[]>(K.index) ?? [];
  const save = (t: MintTask): MintTask => {
    setJson(K.task(t.bookingId), t);
    const ids = index();
    if (!ids.includes(t.bookingId)) setJson(K.index, [...ids, t.bookingId]);
    return t;
  };
  const getTask = (b: string) => getJson<MintTask>(K.task(b));
  const qaOf = (b: string) => getJson<Omit<VerificationEvent, 'type'>>(K.qa(b));

  const kick = () => void minter.tick().catch((err) => console.error('[identity] tick failed:', err));

  function enqueue(input: { bookingId: string; workerId: string; jobId: string; priceUsd: number }): MintTask {
    const existing = getTask(input.bookingId);
    if (existing) return existing;
    const qa = qaOf(input.bookingId);
    const t = now();
    const status: MintTaskStatus = qa ? (qa.passed ? 'queued' : 'rejected') : 'waiting_verification';
    const task = save({ ...input, status, attempts: 0, nextAt: qa ? t : t + grace, createdAt: t, ...(qa && !qa.passed ? { error: 'QA verification failed' } : {}) });
    console.log(`[identity] reputation task for booking ${input.bookingId} (${input.workerId}): ${status}`);
    return task;
  }

  function onBooking(b: Booking) {
    if (b.status !== 'completed') return;
    enqueue({ bookingId: b.id, workerId: b.profileId, jobId: b.jobId, priceUsd: b.priceUsd });
    kick();
  }

  function onEvent(e: HaasEvent | { type: string }) {
    try {
      if (e.type === 'booking.updated') onBooking((e as Extract<HaasEvent, { type: 'booking.updated' }>).booking);
      else if (isVerificationEvent(e)) minter.recordVerification(e);
      else if (isPaymentCollectedEvent(e)) minter.recordPayment(e.jobId, e.txHash);
    } catch (err) {
      console.error('[identity] event handling failed:', err);
    }
  }

  /** The hash of the delivered result: QA's, else Masumi's MIP-004 output hash, else a hash of the booking record. */
  function resultOf(task: MintTask): Pick<JobReceipt, 'resultHash' | 'resultHashKind' | 'qaPassed'> {
    const qa = qaOf(task.bookingId);
    if (qa) return { resultHash: qa.resultHash, resultHashKind: 'qa', qaPassed: qa.passed };
    const job = store.getJob(task.jobId);
    if (job?.client === 'masumi' && job.payment && job.status === 'completed') {
      return { resultHash: resultHash(resultString(job), job.payment.identifierFromPurchaser), resultHashKind: 'masumi-mip004', qaPassed: null };
    }
    const b = store.getBooking(task.bookingId);
    const record = { bookingId: task.bookingId, jobId: task.jobId, workerId: task.workerId, url: b?.url ?? null, ref: b?.platformRef ?? null, note: b?.note ?? null };
    return { resultHash: createHash('sha256').update(canonicalJson(record)).digest('hex'), resultHashKind: 'booking', qaPassed: null };
  }

  function paymentOf(task: MintTask): Pick<JobReceipt, 'paymentTx' | 'paymentKind'> {
    const collected = store.getKv(K.pay(task.jobId));
    if (collected) return { paymentTx: collected, paymentKind: 'masumi-collection' };
    const esc = store.getEscrowByBooking(task.bookingId);
    if (esc?.settleTx) return { paymentTx: esc.settleTx, paymentKind: 'escrow-settle' };
    if (esc?.depositTx) return { paymentTx: esc.depositTx, paymentKind: 'escrow-deposit' };
    const bid = store.getJob(task.jobId)?.payment?.blockchainIdentifier;
    if (bid) return { paymentTx: bid, paymentKind: 'masumi-blockchain-id' };
    return {};
  }

  async function process(task: MintTask): Promise<void> {
    const wallet = registry.walletOf(task.workerId);
    if (!wallet) {
      save({ ...task, status: 'waiting_wallet', error: 'no Cardano wallet bound to this worker' });
      return;
    }
    let cred = registry.credentialOf(task.workerId);
    if (!cred) {
      if (!autoIssue) {
        save({ ...task, status: 'waiting_wallet', error: 'worker has no credential yet' });
        return;
      }
      cred = await registry.issueCredential(task.workerId, wallet);
    }
    const credential = cred;

    await registry.serial(async () => {
      const ref = await chain.readReference(credential.assetName);
      if (!ref) throw new Error(`reference NFT for ${task.workerId} not visible on chain yet`);
      const before = reputationFromFields(ref.fields);
      const job = store.getJob(task.jobId);
      const receiptName = receiptAssetName(task.bookingId);
      const policyId = credential.policyId;
      const receiptUnit = receiptsOn ? `${policyId}${receiptName}` : undefined;
      const base: Omit<JobReceipt, 'txHash' | 'receiptUnit'> = {
        workerId: task.workerId,
        bookingId: task.bookingId,
        jobId: task.jobId,
        ...(job?.client === 'masumi' ? { masumiJobId: job.id } : {}),
        ...resultOf(task),
        ...paymentOf(task),
        priceUsd: task.priceUsd,
        at: now(),
      };
      const rating = qaOf(task.bookingId)?.rating ?? (store.getKv(K.rating(task.bookingId)) ? Number(store.getKv(K.rating(task.bookingId))) : undefined);
      if (rating !== undefined && Number.isFinite(rating)) base.rating = rating;

      // Idempotency: this booking may already be on chain (a crash after submit, or a lost confirmation).
      const already = before.lastBookingId === task.bookingId || (receiptUnit !== undefined && (await chain.holderOf(receiptUnit)) !== null);
      if (already) {
        const receipt: JobReceipt = { ...base, txHash: ref.txHash, ...(receiptUnit ? { receiptUnit } : {}) };
        registry.recordJob(task.workerId, { ...before, lastUpdateTx: ref.txHash }, receipt);
        save({ ...task, status: 'done', txHash: ref.txHash, ...(receiptUnit ? { receiptUnit } : {}), error: undefined });
        return;
      }

      const after = applyJob(before, { ...base, ...(receiptUnit ? { receiptUnit } : {}) });
      const issuedAt = typeof ref.fields.issuedAt === 'number' ? ref.fields.issuedAt : credential.issuedAt;
      const fields = credentialDatumFields({ workerId: task.workerId, walletAddress: credential.walletAddress, issuedAt, reputation: { ...after, lastUpdateTx: ref.txHash } });
      const { txHash } = await chain.updateReference({
        assetName: credential.assetName,
        fields,
        message: cip20Message([`HAAS job receipt: ${task.workerId}`, `job ${base.masumiJobId ?? task.jobId}`, `result ${base.resultHash}`, ...(base.paymentTx ? [`payment ${base.paymentTx}`] : [])]),
        ...(receiptsOn ? { receipt: { assetName: receiptName, holder: credential.walletAddress, metadata: receiptMetadata(policyId, base) } } : {}),
      });
      const receipt: JobReceipt = { ...base, txHash, ...(receiptUnit ? { receiptUnit } : {}) };
      // Recorded as soon as it is submitted; the chain check above covers a crash before this line.
      registry.recordJob(task.workerId, { ...after, lastUpdateTx: txHash }, receipt);
      save({ ...task, status: 'done', txHash, ...(receiptUnit ? { receiptUnit } : {}), error: undefined });
      console.log(`[identity] reputation for ${task.workerId} updated: tx ${txHash}`);
      // The next update spends this output, so wait for it before releasing the queue.
      if (!(await chain.awaitTx(txHash, confirmTimeout))) console.warn(`[identity] tx ${txHash} not confirmed after ${confirmTimeout} ms`);
    });
  }

  async function runOne(bookingId: string): Promise<void> {
    if (busy.has(bookingId)) return;
    busy.add(bookingId);
    try {
      const task = getTask(bookingId);
      if (!task) return;
      try {
        await process(task);
      } catch (err) {
        const attempts = task.attempts + 1;
        const msg = (err as Error).message ?? String(err);
        const failed = attempts >= maxAttempts;
        save({ ...task, attempts, status: failed ? 'failed' : 'queued', nextAt: now() + Math.min(baseBackoff * 2 ** (attempts - 1), 30 * 60_000), error: msg });
        console.error(`[identity] reputation for booking ${bookingId} failed (attempt ${attempts}${failed ? ', giving up' : ', will retry'}): ${msg}`);
      }
    } finally {
      busy.delete(bookingId);
    }
  }

  async function doTick(): Promise<void> {
    const t = now();
    const due: string[] = [];
    const ids = index();
    const open: string[] = [];
    for (const id of ids) {
      const task = getTask(id);
      if (!task) continue;
      if (!OPEN.includes(task.status)) continue;
      open.push(id);
      if (task.status === 'waiting_verification') {
        if (opts.requireVerification || task.nextAt > t) continue;
        save({ ...task, status: 'queued' });
      } else if (task.status === 'waiting_wallet') {
        if (!registry.walletOf(task.workerId)) continue;
      } else if (task.nextAt > t) continue;
      due.push(id);
    }
    if (open.length !== ids.length) setJson(K.index, open);
    for (const id of due) await runOne(id);
  }

  const minter: ReputationMinter = {
    start() {
      if (unsubscribe) return;
      unsubscribe = bus.on(onEvent as (e: HaasEvent) => void);
      timer = setInterval(kick, opts.intervalMs ?? 15_000);
      timer.unref();
      kick();
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick() {
      // Coalesce: a tick requested while one runs starts right after it.
      const run = (ticking ?? Promise.resolve()).then(doTick);
      ticking = run.finally(() => {
        if (ticking === run) ticking = undefined;
      });
      return run;
    },
    recordCompletion(input) {
      const task = enqueue(input);
      kick();
      return task;
    },
    recordVerification(v) {
      setJson(K.qa(v.bookingId), { bookingId: v.bookingId, jobId: v.jobId, passed: v.passed, resultHash: v.resultHash, ...(v.rating !== undefined ? { rating: v.rating } : {}) });
      const task = getTask(v.bookingId);
      if (task?.status === 'waiting_verification') {
        save({ ...task, status: v.passed ? 'queued' : 'rejected', nextAt: now(), ...(v.passed ? {} : { error: 'QA verification failed' }) });
        kick();
      }
    },
    recordPayment(jobId, txHash) {
      store.setKv(K.pay(jobId), txHash);
    },
    rate(bookingId, rating) {
      if (!Number.isFinite(rating) || rating < 0 || rating > 5) throw new Error('rating must be between 0 and 5');
      store.setKv(K.rating(bookingId), String(rating));
    },
    task: getTask,
    tasks(filter = {}) {
      const all: MintTask[] = [];
      for (const id of index()) {
        const t = getTask(id);
        if (t && (!filter.workerId || t.workerId === filter.workerId) && (!filter.open || OPEN.includes(t.status))) all.push(t);
      }
      return all;
    },
  };
  return minter;
}
