// Sokosumi Coworker worker: runs HAAS on the Tasks that Sokosumi hands to our Coworker.
//
// The paid loop (TOKEN2049 agent guide, "Run a paid Task"; docs/LIVE_CARDANO_PAYMENT.md section 9):
//   1. find a READY Task assigned to the Coworker; journal its id and input before any write
//   2. start it: event { status: RUNNING }
//   3. paid Tasks: signed terms from our Masumi Payment Service (POST /payment, Dynamic, 1 USDM)
//   4. post the masumiPayment event: Sokosumi Core charges Workspace credits and funds the escrow
//   5. wait for FundsLocked on our payment service
//   6. run HAAS with no check-in: the result is the ranked shortlist
//   7. hash the exact result, submit the hash through the payment service (POST /payment/submit-result)
//   8. complete the Task: event { status: COMPLETED, comment: result }
//   9. after unlockTime the payment service collects (AUTO_WITHDRAW_PAYMENTS); record the collection tx hash
// Every step is journaled in the store (kv `sokosumi:task:<id>`) before and after its external write, so a
// restart resumes where it stopped and never posts terms, pays or submits twice.
import { randomBytes } from 'node:crypto';
import type { Config } from '../config';
import type { Store } from '../domain/ports';
import type { Brief, JobPayment, Ms } from '../domain/types';
import { inputHash, resultHash } from '../masumi/hash';
import type { PaymentClient, Windows } from '../masumi/payments';
import { quoteFee } from '../masumi/pricing';
import { CoreError, type CoreClient, type MasumiPaymentPayload, type SokosumiTask } from './core';

export type Stage =
  | 'claimed' // seen READY, journaled
  | 'running' // RUNNING event posted
  | 'terms' // payment requested from our MPS, not yet posted to Sokosumi
  | 'payment_posted' // masumiPayment event accepted by Core
  | 'funded' // FundsLocked (or unpaid Task)
  | 'result_ready' // result string and hash saved
  | 'result_submitted' // hash submitted on chain
  | 'completed' // COMPLETED event posted; paid Tasks wait for collection
  | 'collected' // collection tx confirmed
  | 'failed';

export interface TaskRecord {
  taskId: string;
  name: string;
  description: string | null;
  stage: Stage;
  paid: boolean;
  brief?: Brief;
  identifierFromPurchaser?: string;
  inputHash?: string;
  payment?: JobPayment;
  paymentEventId?: string;
  /** Set before the first masumiPayment post, so a retry checks whether the first one went through. */
  paymentPostAttemptedAt?: Ms;
  result?: string;
  resultHash?: string;
  completedEventId?: string;
  collectionTxHash?: string;
  collectedAt?: Ms;
  onChainState?: string;
  error?: string;
  createdAt: Ms;
  updatedAt: Ms;
}

export interface HaasRun {
  result: string;
  jobId?: string;
}

export interface WorkerDeps {
  core: CoreClient;
  store: Pick<Store, 'getKv' | 'setKv'>;
  config: Pick<
    Config,
    | 'SOKOSUMI_COWORKER_ID'
    | 'SOKOSUMI_ORGANIZATION_ID'
    | 'SOKOSUMI_POLL_MS'
    | 'SOKOSUMI_PAID_TASKS'
    | 'SOKOSUMI_PAY_WINDOW_MIN'
    | 'SOKOSUMI_RESULT_WINDOW_MIN'
    | 'SOKOSUMI_UNLOCK_DELAY_MIN'
    | 'SOKOSUMI_DISPUTE_DELAY_MIN'
    | 'MASUMI_NETWORK'
    | 'MASUMI_AGENT_IDENTIFIER'
    | 'MASUMI_SMART_CONTRACT_ADDRESS'
    | 'MASUMI_PRICE_UNIT'
    | 'MASUMI_PRICE_AMOUNT'
    | 'MASUMI_FEE_PERCENT'
    | 'MASUMI_PRICE_MAX_AMOUNT'
  >;
  /** Required for paid Tasks. */
  payments?: PaymentClient;
  /** Turns the Task's text into a brief. */
  toBrief(task: Pick<SokosumiTask, 'name' | 'description'>): Promise<Brief>;
  /** Runs HAAS on the brief with no check-in and returns the exact result text. */
  runHaas(brief: Brief, taskId: string): Promise<HaasRun>;
  now?: () => Ms;
  log?: (msg: string) => void;
}

export interface Worker {
  start(): void;
  stop(): void;
  /** One pass: advance every open Task, then pick up new READY ones. */
  tick(): Promise<void>;
  get(taskId: string): TaskRecord | null;
  /** Resolves when the HAAS runs in flight have finished. */
  drain(): Promise<void>;
}

const KEY = (id: string) => `sokosumi:task:${id}`;
const OPEN = 'sokosumi:open';
const MAX_RESULT_BYTES = 1_048_576;
const COLLECTION_GIVE_UP_MS = 24 * 3_600_000;
const EXPLORER = 'https://preprod.cardanoscan.io/transaction/';

/** A Core answer that means "this already happened" for an idempotent retry. */
const alreadyDone = (err: unknown) => err instanceof CoreError && (err.status === 409 || /already|duplicate|exists/i.test(err.message));

export function createSokosumiWorker(deps: WorkerDeps): Worker {
  const { core, store, config } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(`[sokosumi] ${m}`));
  const coworkerId = config.SOKOSUMI_COWORKER_ID ?? '';
  const running = new Map<string, Promise<void>>();
  let timer: NodeJS.Timeout | undefined;
  let ticking = false;

  const get = (id: string): TaskRecord | null => {
    const raw = store.getKv(KEY(id));
    return raw ? (JSON.parse(raw) as TaskRecord) : null;
  };
  const save = (rec: TaskRecord): TaskRecord => {
    rec.updatedAt = now();
    store.setKv(KEY(rec.taskId), JSON.stringify(rec));
    return rec;
  };
  const openIds = (): string[] => JSON.parse(store.getKv(OPEN) ?? '[]') as string[];
  const setOpen = (ids: string[]) => store.setKv(OPEN, JSON.stringify([...new Set(ids)]));
  const patch = (id: string, p: Partial<TaskRecord>): TaskRecord => {
    const cur = get(id);
    if (!cur) throw new Error(`no journal for task ${id}`);
    return save({ ...cur, ...p });
  };

  const windows = (): Windows => ({
    payMin: config.SOKOSUMI_PAY_WINDOW_MIN,
    resultMin: config.SOKOSUMI_RESULT_WINDOW_MIN,
    unlockDelayMin: config.SOKOSUMI_UNLOCK_DELAY_MIN,
    disputeDelayMin: config.SOKOSUMI_DISPUTE_DELAY_MIN,
  });

  async function fail(rec: TaskRecord, error: string): Promise<void> {
    log(`task ${rec.taskId} failed: ${error}`);
    save({ ...rec, stage: 'failed', error });
    try {
      await core.postEvent(rec.taskId, { status: 'FAILED', comment: `HAAS could not finish this Task: ${error}` });
    } catch (err) {
      log(`task ${rec.taskId}: FAILED event not accepted: ${(err as Error).message}`);
    }
  }

  function masumiPayment(p: JobPayment): MasumiPaymentPayload {
    const policyId = p.agentIdentifier.slice(0, 56).toLowerCase();
    const address = p.smartContractAddress ?? config.MASUMI_SMART_CONTRACT_ADDRESS;
    const v2 = p.paymentSourceType === 'Web3CardanoV2';
    return {
      blockchainIdentifier: p.blockchainIdentifier,
      identifierFromPurchaser: p.identifierFromPurchaser,
      agentIdentifier: p.agentIdentifier,
      sellerVkey: p.sellerVKey,
      submitResultTime: String(p.submitResultTime),
      payByTime: String(p.payByTime),
      unlockTime: String(p.unlockTime),
      externalDisputeUnlockTime: String(p.externalDisputeUnlockTime),
      inputHash: p.inputHash,
      ...(p.paymentSourceType === 'Web3CardanoV1' || p.paymentSourceType === 'Web3CardanoV2' ? { paymentSourceType: p.paymentSourceType } : {}),
      ...(v2 && p.supportedPaymentSourceIndex !== undefined ? { supportedPaymentSourceIndex: p.supportedPaymentSourceIndex } : {}),
      Amounts: p.amounts ?? [],
      ...(address ? { PaymentSource: { network: config.MASUMI_NETWORK, smartContractAddress: address, policyId } } : {}),
    };
  }

  /** Moves one Task forward by as many steps as are ready now. */
  async function advance(id: string): Promise<void> {
    let rec = get(id);
    if (!rec) return;

    if (rec.stage === 'claimed') {
      try {
        await core.postEvent(id, { status: 'RUNNING' });
      } catch (err) {
        // A retry after a lost response: the Task is already RUNNING.
        const t = await core.getTask(id).catch(() => null);
        if (t?.status !== 'RUNNING') throw err;
      }
      rec = save({ ...rec, stage: 'running' });
      log(`task ${id} RUNNING: ${rec.name}`);
    }

    if (rec.stage === 'running') {
      const brief = rec.brief ?? (await deps.toBrief(rec));
      if (!rec.paid) {
        rec = save({ ...rec, brief, stage: 'funded' });
      } else {
        if (!deps.payments) return fail(rec, 'paid Tasks need the Masumi payment service (MASUMI_API_KEY, MASUMI_AGENT_IDENTIFIER)');
        // The purchaser nonce is ours here: Core buys with the terms we sign. 10 bytes = 20 hex, even length.
        const ifp = rec.identifierFromPurchaser ?? randomBytes(10).toString('hex');
        const input = { task_id: id, name: rec.name, description: rec.description ?? '' };
        const hash = inputHash(input, ifp);
        rec = save({ ...rec, brief, identifierFromPurchaser: ifp, inputHash: hash });
        const payment = await deps.payments.createPayment({
          inputHash: hash,
          identifierFromPurchaser: ifp,
          amounts: [quoteFee(brief, config as Config)],
          metadata: JSON.stringify({ sokosumiTaskId: id }),
          windows: windows(),
        });
        if (!payment.amounts?.length) return fail(rec, 'the payment service returned no amount; register the agent with Dynamic pricing');
        rec = save({ ...rec, payment, stage: 'terms' });
        log(
          `task ${id} terms ${payment.blockchainIdentifier.slice(0, 24)}... payBy ${new Date(payment.payByTime).toISOString()} ` +
            `submitResult ${new Date(payment.submitResultTime).toISOString()} unlock ${new Date(payment.unlockTime).toISOString()} ` +
            `dispute ${new Date(payment.externalDisputeUnlockTime).toISOString()}`,
        );
      }
    }

    if (rec.stage === 'terms' && rec.payment) {
      // A retry after a lost response: Core charges and creates the purchase claim in one transaction, so if the
      // escrow is already moving the first post went through. Never post the same terms again then.
      if (rec.paymentPostAttemptedAt && deps.payments) {
        const state = await deps.payments.getPayment(rec.payment.blockchainIdentifier);
        if (state.fundsLocked || state.resultSubmitted || state.withdrawn || (state.onChainState && state.onChainState !== 'None')) {
          rec = save({ ...rec, stage: 'payment_posted' });
        }
      }
    }

    if (rec.stage === 'terms' && rec.payment) {
      if (now() > rec.payment.payByTime) return fail(rec, 'payment terms expired before Sokosumi accepted them');
      const terms = rec.payment;
      rec = save({ ...rec, paymentPostAttemptedAt: rec.paymentPostAttemptedAt ?? now() });
      try {
        const ev = await core.postEvent(id, {
          masumiPayment: masumiPayment(terms),
          comment: `HAAS job fee: ${terms.amounts?.map((a) => `${a.amount} ${a.unit || 'lovelace'}`).join(' + ')}. Escrow ${terms.blockchainIdentifier.slice(0, 24)}...`,
        });
        rec = save({ ...rec, paymentEventId: ev.id, stage: 'payment_posted' });
        log(`task ${id} masumiPayment event ${ev.id} posted`);
      } catch (err) {
        if (alreadyDone(err)) {
          rec = save({ ...rec, stage: 'payment_posted' });
        } else if (err instanceof CoreError && err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
          return fail(rec, `Sokosumi rejected the payment: ${err.message}`);
        } else throw err;
      }
    }

    if (rec.stage === 'payment_posted' && rec.payment && deps.payments) {
      const state = await deps.payments.getPayment(rec.payment.blockchainIdentifier);
      if (state.fundsLocked || state.resultSubmitted || state.withdrawn) {
        rec = save({ ...rec, stage: 'funded', onChainState: state.onChainState ?? 'FundsLocked', payment: { ...rec.payment, paidAt: now() } });
        log(`task ${id} FundsLocked`);
      } else if (now() > rec.payment.payByTime) {
        return fail(rec, 'escrow was not funded before payByTime');
      } else return;
    }

    if (rec.stage === 'funded') {
      if (!running.has(id)) {
        const brief = rec.brief!;
        const job = deps
          .runHaas(brief, id)
          .then(({ result }) => {
            let text = result;
            if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) text = Buffer.from(text, 'utf8').subarray(0, MAX_RESULT_BYTES - 64).toString('utf8') + '\n[truncated]';
            const cur = get(id)!;
            const hash = cur.identifierFromPurchaser ? resultHash(text, cur.identifierFromPurchaser) : undefined;
            save({ ...cur, result: text, resultHash: hash, stage: 'result_ready' });
            log(`task ${id} result ready (${Buffer.byteLength(text, 'utf8')} bytes${hash ? `, hash ${hash}` : ''})`);
          })
          .catch((err: Error) => fail(get(id)!, `HAAS run failed: ${err.message}`))
          .finally(() => running.delete(id));
        running.set(id, job);
      }
      return;
    }

    if (rec.stage === 'result_ready') {
      if (rec.paid && rec.payment && deps.payments && rec.resultHash) {
        if (now() > rec.payment.submitResultTime) {
          log(`task ${id}: submitResultTime passed before the result was ready; the buyer can claim a refund`);
        } else {
          const state = await deps.payments.getPayment(rec.payment.blockchainIdentifier);
          if (!state.resultSubmitted) await deps.payments.submitResult(rec.payment.blockchainIdentifier, rec.resultHash);
          log(`task ${id} result hash submitted; collection after ${new Date(rec.payment.unlockTime).toISOString()}`);
        }
      }
      rec = save({ ...rec, stage: 'result_submitted' });
    }

    if (rec.stage === 'result_submitted') {
      try {
        const ev = await core.postEvent(id, { status: 'COMPLETED', comment: rec.result ?? '' });
        rec = save({ ...rec, completedEventId: ev.id, stage: 'completed' });
      } catch (err) {
        const t = await core.getTask(id).catch(() => null);
        if (t?.status !== 'COMPLETED') throw err;
        rec = save({ ...rec, stage: 'completed' });
      }
      log(`task ${id} COMPLETED${rec.completedEventId ? ` (event ${rec.completedEventId})` : ''}`);
      if (!rec.paid) setOpen(openIds().filter((x) => x !== id));
      return;
    }

    if (rec.stage === 'completed' && rec.paid && rec.payment && deps.payments) {
      if (now() < rec.payment.unlockTime) return;
      if (now() > rec.payment.externalDisputeUnlockTime + COLLECTION_GIVE_UP_MS) {
        log(`task ${id}: no collection a day after the dispute window; check the payment service (AUTO_WITHDRAW_PAYMENTS)`);
        setOpen(openIds().filter((x) => x !== id));
        return;
      }
      const state = await deps.payments.getPayment(rec.payment.blockchainIdentifier);
      if (state.onChainState && state.onChainState !== rec.onChainState) rec = save({ ...rec, onChainState: state.onChainState });
      let tx = state.withdrawn ? state.collectionTxHash : null;
      if (state.withdrawn && !tx) tx = (await core.receipt(id).catch(() => null))?.txHash ?? null;
      if (tx) {
        save({ ...rec, collectionTxHash: tx, collectedAt: now(), stage: 'collected' });
        setOpen(openIds().filter((x) => x !== id));
        log(`task ${id} collected: ${EXPLORER}${tx}`);
      }
    }
  }

  async function pickUp(): Promise<void> {
    const tasks = await core.listReadyTasks(coworkerId);
    for (const t of tasks) {
      if (t.status !== 'READY' || (t.assigneeId && t.assigneeId !== coworkerId) || get(t.id)) continue;
      const org = config.SOKOSUMI_ORGANIZATION_ID;
      if (org && (org === 'personal' ? Boolean(t.organizationId) : t.organizationId !== org)) continue;
      const t0 = now();
      save({ taskId: t.id, name: t.name, description: t.description, stage: 'claimed', paid: config.SOKOSUMI_PAID_TASKS, createdAt: t0, updatedAt: t0 });
      setOpen([...openIds(), t.id]);
      log(`task ${t.id} picked up${config.SOKOSUMI_PAID_TASKS ? ' (paid)' : ''}`);
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      for (const id of openIds()) {
        const rec = get(id);
        if (!rec || rec.stage === 'failed' || rec.stage === 'collected') {
          setOpen(openIds().filter((x) => x !== id));
          continue;
        }
        await advance(id).catch((err: Error) => log(`task ${id} (${rec.stage}) will retry: ${err.message}`));
      }
      await pickUp().catch((err: Error) => log(`listing READY tasks failed: ${err.message}`));
      // New Tasks start at once rather than one poll later.
      for (const id of openIds()) if (get(id)?.stage === 'claimed') await advance(id).catch((err: Error) => log(`task ${id} will retry: ${err.message}`));
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer) return;
      log(`worker on for Coworker ${coworkerId}, every ${config.SOKOSUMI_POLL_MS} ms${config.SOKOSUMI_PAID_TASKS ? ', paid Tasks' : ''}`);
      void tick();
      timer = setInterval(() => void tick(), config.SOKOSUMI_POLL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    tick,
    get,
    async drain() {
      await Promise.allSettled([...running.values()]);
    },
  };
}
