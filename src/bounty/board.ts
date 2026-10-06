// The bounty board: registered workers, posted bounties and their lifecycle.
//
//   posted --claim--> claimed --submit--> submitted --verify (QA)--> verified --pay--> paid
//     |                 |  ^                  |  \--revise (QA)--> claimed
//     +--(claimBy)--> expired (stage claim)   +----reject---> rejected
//                       +--(submitBy)--> expired (stage submit)
//   any open state --cancel--> cancelled
//
// Everything is kept in the store's key-value table. Every state change is synchronous
// (read, check, write with no await in between), so in one process two claims can never
// both win.

import { randomBytes } from 'node:crypto';
import type { Config } from '../config';
import { newId } from '../domain/ids';
import type { EventBus, Store } from '../domain/ports';
import type { BountyStatus } from '../domain/types';
import type { WorkerNoticeKind, WorkerNotifier } from './notifier';
import { distanceKm } from './places';
import { summarize, validateResult } from './spec';
import type { Bounty, BountyMessage, BountyResult, BountySpec, GeoPoint, QaVerdict, Worker } from './types';

/** Pays a worker their reward. The default only records it; a chain transfer can replace it. */
export interface WorkerPayout {
  pay(worker: Worker, bounty: Bounty): Promise<{ chain: 'cardano' | 'solana' | 'none'; address?: string; ref?: string }>;
}

export function createLedgerPayout(log: (line: string) => void = (l) => console.log(l)): WorkerPayout {
  return {
    async pay(worker, bounty) {
      const chain = worker.wallets.solana ? 'solana' : worker.wallets.cardano ? 'cardano' : 'none';
      const address = chain === 'solana' ? worker.wallets.solana : chain === 'cardano' ? worker.wallets.cardano : undefined;
      const ref = `ledger_${bounty.id}`;
      log(`[bounty] payout ${bounty.reward.amount} ${bounty.reward.currency} (~$${bounty.rewardUsd}) to ${worker.name} on ${chain}${address ? ` ${address}` : ''} (${ref})`);
      return { chain, address, ref };
    },
  };
}

export interface BoardDeps {
  store: Store;
  bus: EventBus;
  config: Config;
  notifier: WorkerNotifier;
  payout?: WorkerPayout;
  now?: () => number;
}

export type WorkerInput = Omit<Worker, 'createdAt' | 'linkCode' | 'completed' | 'available' | 'verified'> &
  Partial<Pick<Worker, 'linkCode' | 'completed' | 'available' | 'verified'>>;

export interface PostInput {
  task: string;
  spec: BountySpec;
  reward: { amount: number; currency: string };
  rewardUsd: number;
  bookingId?: string;
  jobId?: string;
  /** The worker chosen by the router; offered first (and only, in direct mode). */
  workerId?: string;
  mode?: 'broadcast' | 'direct';
}

export type Outcome<T = Bounty> = { ok: true; bounty: T } | { ok: false; error: string };

export interface SubmitInput {
  fields: Record<string, unknown>;
  notes?: string;
  photoUrl?: string;
}

const OPEN: BountyStatus[] = ['posted', 'claimed', 'submitted', 'verified'];
const NEXT: Record<BountyStatus, BountyStatus[]> = {
  posted: ['claimed', 'expired', 'cancelled'],
  claimed: ['submitted', 'expired', 'cancelled'],
  submitted: ['verified', 'claimed', 'rejected', 'cancelled'],
  // 'claimed': the hirer or the booking's QA sent a checked submission back for a revision.
  verified: ['paid', 'claimed', 'cancelled'],
  paid: [],
  rejected: [],
  expired: [],
  cancelled: [],
};

const K = {
  workers: 'bounty:workers',
  worker: (id: string) => `bounty:worker:${id}`,
  tg: (chat: string) => `bounty:tg:${chat}`,
  all: 'bounty:all',
  bounty: (id: string) => `bounty:b:${id}`,
  code: (code: string) => `bounty:code:${code.toUpperCase()}`,
  token: (token: string) => `bounty:token:${token}`,
};

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function createBountyBoard(deps: BoardDeps) {
  const { store, bus, config, notifier } = deps;
  const payout = deps.payout ?? createLedgerPayout();
  const clock = deps.now ?? (() => Date.now());

  const readJson = <T>(key: string): T | null => {
    const raw = store.getKv(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };
  const writeJson = (key: string, value: unknown) => store.setKv(key, JSON.stringify(value));
  const addToIndex = (key: string, id: string) => {
    const ids = readJson<string[]>(key) ?? [];
    if (!ids.includes(id)) writeJson(key, [...ids, id]);
  };

  // ------------------------------------------------------------- workers

  function registerWorker(input: WorkerInput): Worker {
    const existing = getWorker(input.id);
    const worker: Worker = {
      available: true,
      verified: false,
      completed: 0,
      ...existing,
      ...input,
      linkCode: input.linkCode ?? existing?.linkCode ?? randomBytes(4).toString('hex'),
      createdAt: existing?.createdAt ?? clock(),
    };
    writeJson(K.worker(worker.id), worker);
    addToIndex(K.workers, worker.id);
    if (worker.contact.telegramId) store.setKv(K.tg(worker.contact.telegramId), worker.id);
    return worker;
  }

  const getWorker = (id: string) => readJson<Worker>(K.worker(id));
  const listWorkers = () => (readJson<string[]>(K.workers) ?? []).map(getWorker).filter((w): w is Worker => w !== null);

  function updateWorker(id: string, patch: Partial<Worker>): Worker {
    const cur = getWorker(id);
    if (!cur) throw new Error(`Worker not found: ${id}`);
    const next = { ...cur, ...patch };
    writeJson(K.worker(id), next);
    if (next.contact.telegramId) store.setKv(K.tg(next.contact.telegramId), id);
    return next;
  }

  function workerByTelegram(chatId: string): Worker | null {
    const id = store.getKv(K.tg(chatId));
    return id ? getWorker(id) : null;
  }

  /** Connects a Telegram chat to the worker whose link code this is. */
  function linkTelegram(code: string, chatId: string): Worker | null {
    const w = listWorkers().find((x) => x.linkCode === code.trim());
    if (!w) return null;
    return updateWorker(w.id, { contact: { ...w.contact, telegramId: chatId } });
  }

  /** Verified, available workers by distance from `point` (all of them, unsorted, when point is unknown). */
  function nearby(point: GeoPoint | undefined, opts: { radiusKm?: number; limit?: number } = {}): { worker: Worker; km?: number }[] {
    const radius = opts.radiusKm ?? config.BOUNTY_RADIUS_KM;
    const list = listWorkers()
      .filter((w) => w.verified && w.available)
      .map((worker) => ({ worker, km: point ? distanceKm(point, worker.location) : undefined }))
      .filter((x) => x.km === undefined || x.km <= radius)
      .sort((a, b) => (a.km ?? 0) - (b.km ?? 0));
    return opts.limit ? list.slice(0, opts.limit) : list;
  }

  // ------------------------------------------------------------ bounties

  const get = (id: string) => readJson<Bounty>(K.bounty(id));
  const list = (filter: { status?: BountyStatus[]; bookingId?: string } = {}) =>
    (readJson<string[]>(K.all) ?? [])
      .map(get)
      .filter((b): b is Bounty => b !== null)
      .filter((b) => (!filter.status || filter.status.includes(b.status)) && (!filter.bookingId || b.bookingId === filter.bookingId));

  function byCode(code: string): Bounty | null {
    const id = store.getKv(K.code(code));
    return id ? get(id) : null;
  }

  function byToken(token: string): { bounty: Bounty; worker: Worker } | null {
    const ref = readJson<{ bountyId: string; workerId: string }>(K.token(token));
    if (!ref) return null;
    const bounty = get(ref.bountyId);
    const worker = getWorker(ref.workerId);
    return bounty && worker ? { bounty, worker } : null;
  }

  const pageUrl = (token: string) => `${config.PUBLIC_URL.replace(/\/$/, '')}/w/${token}`;
  const offerOf = (b: Bounty, workerId: string) => b.offers.find((o) => o.workerId === workerId);

  function save(b: Bounty, patch: Partial<Bounty>, reason?: string, stage?: 'claim' | 'submit'): Bounty {
    const next: Bounty = { ...b, ...patch, updatedAt: clock() };
    writeJson(K.bounty(b.id), next);
    if (patch.status && patch.status !== b.status) {
      bus.emit({
        type: 'bounty.updated',
        bounty: {
          bountyId: next.id,
          bookingId: next.bookingId,
          jobId: next.jobId,
          status: next.status,
          workerId: next.workerId,
          rewardUsd: next.rewardUsd,
          ...(stage && { stage }),
          ...((reason ?? next.reason) && { reason: reason ?? next.reason }),
          at: next.updatedAt,
        },
      });
    }
    return next;
  }

  /** Synchronous check-and-set of the status. */
  function transition(id: string, to: BountyStatus, patch: Partial<Bounty> = {}, opts: { from?: BountyStatus[]; reason?: string; stage?: 'claim' | 'submit' } = {}): Outcome {
    const b = get(id);
    if (!b) return { ok: false, error: 'No such bounty' };
    if (opts.from && !opts.from.includes(b.status)) return { ok: false, error: `Bounty is ${b.status}` };
    if (!NEXT[b.status].includes(to)) return { ok: false, error: `Bounty is ${b.status}` };
    return { ok: true, bounty: save(b, { ...patch, status: to, ...(opts.reason && { reason: opts.reason }) }, opts.reason, opts.stage) };
  }

  function tell(workerId: string, b: Bounty, kind: WorkerNoticeKind, text: string): void {
    const w = getWorker(workerId);
    if (!w) return;
    const offer = offerOf(b, workerId);
    void notifier
      .notify(w, { kind, bounty: b, text, url: offer ? pageUrl(offer.token) : undefined })
      .catch((err) => console.error(`[bounty] notify ${workerId} failed:`, err instanceof Error ? err.message : err));
  }

  function newCode(): string {
    for (;;) {
      const bytes = randomBytes(4);
      const code = [...bytes].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
      if (!store.getKv(K.code(code))) return code;
    }
  }

  function post(input: PostInput): Bounty {
    const mode = input.mode ?? config.BOUNTY_MODE;
    const chosen = input.workerId ? getWorker(input.workerId) : null;
    if (input.workerId && !chosen) throw new Error(`Worker not found: ${input.workerId}`);
    if (chosen && !chosen.verified) throw new Error(`${chosen.name} is not verified`);

    const targets: Worker[] = chosen ? [chosen] : [];
    if (mode === 'broadcast') {
      for (const { worker } of nearby(input.spec.place?.point, { limit: config.BOUNTY_BROADCAST_MAX })) {
        if (targets.length >= Math.max(1, config.BOUNTY_BROADCAST_MAX)) break;
        if (!targets.some((t) => t.id === worker.id)) targets.push(worker);
      }
    }
    if (!targets.length) throw new Error('No verified worker is available nearby');

    const t = clock();
    const bounty: Bounty = {
      id: newId('bty'),
      code: newCode(),
      bookingId: input.bookingId,
      jobId: input.jobId,
      task: input.task,
      spec: input.spec,
      rewardUsd: input.rewardUsd,
      reward: input.reward,
      status: 'posted',
      mode,
      offers: targets.map((w) => ({ workerId: w.id, token: randomBytes(12).toString('base64url'), offeredAt: t })),
      claimBy: t + config.BOUNTY_CLAIM_MIN * 60_000,
      messages: [],
      createdAt: t,
      updatedAt: t,
    };
    writeJson(K.bounty(bounty.id), bounty);
    addToIndex(K.all, bounty.id);
    store.setKv(K.code(bounty.code), bounty.id);
    for (const o of bounty.offers) writeJson(K.token(o.token), { bountyId: bounty.id, workerId: o.workerId });
    bus.emit({ type: 'bounty.updated', bounty: { bountyId: bounty.id, bookingId: bounty.bookingId, jobId: bounty.jobId, status: 'posted', rewardUsd: bounty.rewardUsd, at: t } });

    const first = mode === 'broadcast' && bounty.offers.length > 1 ? ' First to claim gets it.' : '';
    for (const o of bounty.offers) tell(o.workerId, bounty, 'offer', `New task: ${bounty.spec.title} [${bounty.code}]${first}`);
    return bounty;
  }

  function claim(bountyId: string, workerId: string): Outcome {
    const b = get(bountyId);
    if (!b) return { ok: false, error: 'No such bounty' };
    if (!offerOf(b, workerId)) return { ok: false, error: 'This task was not offered to you' };
    if (b.status === 'claimed' && b.workerId === workerId) return { ok: true, bounty: b };
    if (b.status !== 'posted') return { ok: false, error: b.status === 'claimed' ? 'Someone else already claimed this task' : `This task is ${b.status}` };
    if (clock() > b.claimBy) return { ok: false, error: 'This task has expired' };
    const t = clock();
    const res = transition(bountyId, 'claimed', { workerId, claimedAt: t, submitBy: t + config.BOUNTY_SUBMIT_MIN * 60_000 }, { from: ['posted'] });
    if (!res.ok) return res;
    const due = new Date(res.bounty.submitBy!).toISOString().slice(11, 16);
    tell(workerId, res.bounty, 'claimed', `It's yours: ${res.bounty.spec.title}. Submit the result by ${due} UTC.\n\n${res.bounty.spec.instructions}`);
    for (const o of res.bounty.offers) if (o.workerId !== workerId) tell(o.workerId, res.bounty, 'taken', `Task ${res.bounty.code} was claimed by someone else.`);
    return res;
  }

  function submit(bountyId: string, workerId: string, input: SubmitInput): Outcome {
    const b = get(bountyId);
    if (!b) return { ok: false, error: 'No such bounty' };
    if (b.workerId !== workerId) return { ok: false, error: 'Only the worker who claimed this task can submit it' };
    if (b.status !== 'claimed') return { ok: false, error: `This task is ${b.status}` };
    const v = validateResult(b.spec, input.fields);
    if (!v.ok) return { ok: false, error: v.errors.join('; ') };
    const photoUrl = input.photoUrl?.trim();
    if (photoUrl && !/^https?:\/\/\S+$/.test(photoUrl)) return { ok: false, error: 'Photo link must be an http(s) URL' };
    const result: BountyResult = {
      data: v.data,
      summary: summarize(b.spec, v.data),
      ...(input.notes?.trim() && { notes: input.notes.trim().slice(0, 1000) }),
      ...(photoUrl && { photoUrl }),
      submittedAt: clock(),
    };
    return transition(bountyId, 'submitted', { result, feedback: undefined }, { from: ['claimed'] });
  }

  /** Verification asked for changes: back to the worker with the feedback and a fresh deadline. */
  /** Sends a submission back; also from 'verified', when the booking's own QA or the hirer turns it down. */
  function requestRevision(bountyId: string, feedback: string, qa?: QaVerdict): Outcome {
    const revisions = (get(bountyId)?.revisions ?? 0) + 1;
    const res = transition(bountyId, 'claimed', { feedback, revisions, submitBy: clock() + config.BOUNTY_SUBMIT_MIN * 60_000, ...(qa && { qa }) }, { from: ['submitted', 'verified'] });
    if (res.ok && res.bounty.workerId) tell(res.bounty.workerId, res.bounty, 'revision', `Please fix task ${res.bounty.code}: ${feedback}`);
    return res;
  }

  /** The submission passed the check: the client can now see it. Payment waits for acceptance. */
  function verify(bountyId: string, qa: QaVerdict): Outcome {
    return transition(bountyId, 'verified', { qa }, { from: ['submitted'] });
  }

  /** The submission passed verification: mark it, then pay the worker. */
  async function verifyAndPay(bountyId: string): Promise<Outcome> {
    let b = get(bountyId);
    if (!b) return { ok: false, error: 'No such bounty' };
    if (b.status === 'paid') return { ok: true, bounty: b };
    if (b.status === 'submitted') {
      const res = transition(bountyId, 'verified', { qa: { ok: true, issues: [], by: 'operator', at: clock() } }, { from: ['submitted'] });
      if (!res.ok) return res;
      b = res.bounty;
    }
    if (b.status !== 'verified') return { ok: false, error: `This task is ${b.status}` };
    const worker = b.workerId ? getWorker(b.workerId) : null;
    if (!worker) return { ok: false, error: 'Worker not found' };
    try {
      const paid = await payout.pay(worker, b);
      const res = transition(bountyId, 'paid', { payout: { ...paid, at: clock() } }, { from: ['verified'] });
      if (res.ok) {
        updateWorker(worker.id, { completed: worker.completed + 1 });
        tell(worker.id, res.bounty, 'paid', `Thanks! Task ${b.code} accepted. ${b.reward.amount} ${b.reward.currency} is on its way${paid.address ? ` to ${paid.address}` : ''}.`);
      }
      return res;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      save(get(bountyId)!, { reason: `payout failed: ${error}` });
      return { ok: false, error: `payout failed: ${error}` };
    }
  }

  function reject(bountyId: string, reason: string, qa?: QaVerdict): Outcome {
    const res = transition(bountyId, 'rejected', qa ? { qa } : {}, { from: ['submitted'], reason });
    if (res.ok && res.bounty.workerId) tell(res.bounty.workerId, res.bounty, 'rejected', `Task ${res.bounty.code} was not accepted: ${reason}`);
    return res;
  }

  function cancel(bountyId: string, reason: string): Outcome {
    const b = get(bountyId);
    if (!b) return { ok: false, error: 'No such bounty' };
    if (!OPEN.includes(b.status)) return { ok: true, bounty: b };
    const res = transition(bountyId, 'cancelled', {}, { reason });
    if (res.ok) for (const id of new Set([...(b.workerId ? [b.workerId] : []), ...(b.status === 'posted' ? b.offers.map((o) => o.workerId) : [])])) tell(id, res.bounty, 'cancelled', `Task ${b.code} was cancelled: ${reason}`);
    return res;
  }

  function addMessage(bountyId: string, from: BountyMessage['from'], text: string): Bounty | null {
    const b = get(bountyId);
    if (!b) return null;
    const message: BountyMessage = { id: newId('bm'), from, text: text.slice(0, 2000), at: clock() };
    const next = save(b, { messages: [...b.messages, message] });
    if (from === 'agent' && b.workerId) tell(b.workerId, next, 'message', `About task ${b.code}: ${text}`);
    return next;
  }

  /** Expires bounties nobody claimed in time, and claims not submitted by the deadline. */
  function tick(): Bounty[] {
    const t = clock();
    const expired: Bounty[] = [];
    for (const b of list({ status: ['posted', 'claimed'] })) {
      if (b.status === 'posted' && t > b.claimBy) {
        const res = transition(b.id, 'expired', {}, { from: ['posted'], stage: 'claim', reason: 'nobody claimed it in time' });
        if (res.ok) {
          expired.push(res.bounty);
          for (const o of b.offers) tell(o.workerId, res.bounty, 'expired', `Task ${b.code} has expired.`);
        }
      } else if (b.status === 'claimed' && b.submitBy && t > b.submitBy) {
        const res = transition(b.id, 'expired', {}, { from: ['claimed'], stage: 'submit', reason: 'the result was not submitted by the deadline' });
        if (res.ok) {
          expired.push(res.bounty);
          if (b.workerId) tell(b.workerId, res.bounty, 'expired', `Task ${b.code} expired: the deadline passed.`);
        }
      }
    }
    return expired;
  }

  return {
    registerWorker,
    getWorker,
    listWorkers,
    updateWorker,
    workerByTelegram,
    linkTelegram,
    nearby,
    post,
    get,
    list,
    byCode,
    byToken,
    pageUrl,
    claim,
    submit,
    requestRevision,
    verify,
    verifyAndPay,
    reject,
    cancel,
    addMessage,
    tick,
  };
}

export type BountyBoard = ReturnType<typeof createBountyBoard>;
