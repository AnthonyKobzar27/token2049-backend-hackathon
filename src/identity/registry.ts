// IdentityRegistry: which wallet a worker is bound to, their credential, their reputation, and a
// cache of what the chain says about them. Local state lives in the store's key-value table; the
// chain is the source of truth and is re-read in the background, never on the routing path.

import type { Store } from '../domain/ports';
import type { ReputationChain } from './chain';
import { explorer } from './cip68';
import type { CredentialIssuer, CredentialStatus } from './issuer';
import type { CardanoNetwork, JobReceipt, OnChainSignal, Reputation, WorkerCredential } from './types';
import { avgRating, emptyReputation } from './types';

const K = {
  workers: 'identity:workers',
  wallet: (w: string) => `identity:wallet:${w}`,
  byWallet: (a: string) => `identity:walletidx:${a}`,
  cred: (w: string) => `identity:cred:${w}`,
  rep: (w: string) => `identity:rep:${w}`,
  receipts: (w: string) => `identity:receipts:${w}`,
};

export interface ChainCheck {
  status: CredentialStatus;
  checkedAt: number;
  error?: string;
}

export interface IdentityRegistry {
  readonly network: CardanoNetwork;
  readonly chain: ReputationChain;
  bindWallet(workerId: string, address: string): void;
  walletOf(workerId: string): string | undefined;
  workerByWallet(address: string): string | undefined;
  credentialOf(workerId: string): WorkerCredential | undefined;
  /** Local mirror of the on-chain totals. */
  reputationOf(workerId: string): Reputation;
  receiptsOf(workerId: string): JobReceipt[];
  knownWorkers(): string[];
  /** Idempotent: returns the existing credential, or mints one and waits for it to confirm. */
  issueCredential(workerId: string, walletAddress?: string): Promise<WorkerCredential>;
  /** Called by the minter after a reputation transaction. */
  recordJob(workerId: string, reputation: Reputation, receipt: JobReceipt): void;
  /** Runs chain writes one at a time (they spend the same operator UTxOs). */
  serial<T>(fn: () => Promise<T>): Promise<T>;
  /** Re-reads the chain for one worker (bounded by timeoutMs) and caches the answer. */
  refresh(workerId: string, timeoutMs?: number): Promise<ChainCheck | null>;
  lastCheck(workerId: string): ChainCheck | undefined;
  /** Synchronous, cache-only signals for ranking; schedules background refreshes for stale entries. */
  signals(workerIds: string[]): Map<string, OnChainSignal>;
  /** Refreshes every known worker in the background. */
  warm(): void;
}

export interface RegistryDeps {
  store: Store;
  chain: ReputationChain;
  issuer: CredentialIssuer;
  /** Cache lifetime for chain reads. */
  ttlMs?: number;
  confirmTimeoutMs?: number;
  now?: () => number;
}

export function createIdentityRegistry(deps: RegistryDeps): IdentityRegistry {
  const { store, chain, issuer } = deps;
  const ttl = deps.ttlMs ?? 5 * 60_000;
  const confirmTimeout = deps.confirmTimeoutMs ?? 240_000;
  const now = deps.now ?? Date.now;
  const checks = new Map<string, ChainCheck>();
  const refreshing = new Map<string, Promise<ChainCheck | null>>();
  const issuing = new Map<string, Promise<WorkerCredential>>();
  let tail: Promise<unknown> = Promise.resolve();

  const getJson = <T>(key: string): T | undefined => {
    const v = store.getKv(key);
    if (!v) return undefined;
    try {
      return JSON.parse(v) as T;
    } catch {
      return undefined;
    }
  };
  const setJson = (key: string, v: unknown) => store.setKv(key, JSON.stringify(v));

  function remember(workerId: string) {
    const all = getJson<string[]>(K.workers) ?? [];
    if (!all.includes(workerId)) setJson(K.workers, [...all, workerId]);
  }

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  const reg: IdentityRegistry = {
    network: chain.network,
    chain,

    bindWallet(workerId, address) {
      const cred = reg.credentialOf(workerId);
      if (cred && cred.walletAddress !== address) throw new Error(`worker ${workerId} already holds a credential bound to ${cred.walletAddress}`);
      const owner = reg.workerByWallet(address);
      if (owner && owner !== workerId) throw new Error(`wallet ${address} is already bound to worker ${owner}`);
      store.setKv(K.wallet(workerId), address);
      store.setKv(K.byWallet(address), workerId);
      remember(workerId);
    },
    walletOf: (w) => store.getKv(K.wallet(w)) ?? undefined,
    workerByWallet: (a) => store.getKv(K.byWallet(a)) ?? undefined,
    credentialOf: (w) => getJson<WorkerCredential>(K.cred(w)),
    reputationOf: (w) => getJson<Reputation>(K.rep(w)) ?? emptyReputation(),
    receiptsOf: (w) => getJson<JobReceipt[]>(K.receipts(w)) ?? [],
    knownWorkers: () => getJson<string[]>(K.workers) ?? [],

    issueCredential(workerId, walletAddress) {
      const existing = reg.credentialOf(workerId);
      if (existing) return Promise.resolve(existing);
      const pending = issuing.get(workerId);
      if (pending) return pending;
      const wallet = walletAddress ?? reg.walletOf(workerId);
      if (!wallet) return Promise.reject(new Error(`no wallet bound to worker ${workerId}`));
      reg.bindWallet(workerId, wallet);
      const p = serial(async () => {
        const again = reg.credentialOf(workerId);
        if (again) return again;
        const cred = await issuer.issue({ workerId, walletAddress: wallet, reputation: reg.reputationOf(workerId) });
        setJson(K.cred(workerId), cred);
        console.log(`[identity] credential for ${workerId}: tx ${cred.txHash}`);
        if (!(await chain.awaitTx(cred.txHash, confirmTimeout))) console.warn(`[identity] credential tx ${cred.txHash} not confirmed after ${confirmTimeout} ms`);
        return cred;
      }).finally(() => issuing.delete(workerId));
      issuing.set(workerId, p);
      return p;
    },

    recordJob(workerId, reputation, receipt) {
      setJson(K.rep(workerId), reputation);
      const list = reg.receiptsOf(workerId).filter((r) => r.bookingId !== receipt.bookingId);
      setJson(K.receipts(workerId), [...list, receipt]);
      remember(workerId);
      checks.delete(workerId);
    },

    serial,

    refresh(workerId, timeoutMs = 10_000) {
      const cred = reg.credentialOf(workerId);
      if (!cred) return Promise.resolve(null);
      const inflight = refreshing.get(workerId);
      if (inflight) return inflight;
      const read = issuer
        .status(cred)
        .then((status): ChainCheck => ({ status, checkedAt: now() }))
        .catch((err: unknown): ChainCheck => ({ status: checks.get(workerId)?.status ?? { valid: false, bound: false }, checkedAt: now(), error: (err as Error).message }));
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<null>((r) => {
        timer = setTimeout(() => r(null), timeoutMs);
        timer.unref?.();
      });
      const p = Promise.race([read, timeout]).then((c) => {
        if (timer) clearTimeout(timer);
        return c;
      });
      // The cache is filled by the read whenever it lands, even after the caller stopped waiting.
      void read.then((c) => {
        if (!c.error || !checks.has(workerId)) checks.set(workerId, c);
        refreshing.delete(workerId);
      });
      refreshing.set(workerId, read);
      return p;
    },

    lastCheck: (w) => checks.get(w),

    signals(workerIds) {
      const out = new Map<string, OnChainSignal>();
      for (const id of workerIds) {
        const cred = reg.credentialOf(id);
        if (!cred) continue;
        const check = checks.get(id);
        if (!check || now() - check.checkedAt > ttl) void reg.refresh(id).catch(() => undefined);
        // Only what the chain confirmed counts as verified; the local mirror fills in until the first read lands.
        const verified = !!check && check.status.valid && check.status.bound;
        const rep = check?.status.reputation ?? reg.reputationOf(id);
        const sig: OnChainSignal = { verified, jobsCompleted: rep.jobsCompleted };
        const avg = avgRating(rep);
        if (avg !== undefined) sig.avgRating = avg;
        out.set(id, sig);
      }
      return out;
    },

    warm() {
      for (const id of reg.knownWorkers()) void reg.refresh(id, 30_000).catch(() => undefined);
    },
  };
  return reg;
}

// ------------------------------------------------------------------- view

/** The JSON behind GET /workers/:id/reputation. */
export function workerView(reg: IdentityRegistry, workerId: string, extra: { pending?: unknown[] } = {}) {
  const ex = explorer(reg.network);
  const wallet = reg.walletOf(workerId);
  const cred = reg.credentialOf(workerId);
  const check = reg.lastCheck(workerId);
  const rep = check?.status.reputation ?? reg.reputationOf(workerId);
  const receipts = reg.receiptsOf(workerId);
  return {
    workerId,
    network: reg.network,
    chain: reg.chain.kind,
    wallet: wallet ?? null,
    walletUrl: wallet ? ex.address(wallet) : null,
    credential: cred
      ? {
          issuer: cred.issuer,
          policyId: cred.policyId,
          assetName: cred.assetName,
          referenceAsset: cred.refUnit,
          userAsset: cred.userUnit,
          txHash: cred.txHash,
          issuedAt: new Date(cred.issuedAt).toISOString(),
          links: { tx: ex.tx(cred.txHash), referenceToken: ex.token(cred.refUnit), userToken: ex.token(cred.userUnit), policy: ex.policy(cred.policyId) },
        }
      : null,
    onChain: check
      ? { verified: check.status.valid && check.status.bound, valid: check.status.valid, bound: check.status.bound, holder: check.status.holder ?? null, checkedAt: new Date(check.checkedAt).toISOString(), error: check.error ?? null }
      : null,
    reputation: {
      jobsCompleted: rep.jobsCompleted,
      verifiedJobs: rep.verifiedJobs,
      avgRating: avgRating(rep) ?? null,
      ratedJobs: rep.ratedJobs,
      totalEarnedUsd: rep.totalEarnedUsd,
      lastJobId: rep.lastJobId ?? null,
      lastResultHash: rep.lastResultHash ?? null,
      lastPaymentTx: rep.lastPaymentTx ?? null,
      lastUpdateTx: rep.lastUpdateTx ?? null,
      links: rep.lastUpdateTx ? { lastUpdateTx: ex.tx(rep.lastUpdateTx) } : {},
    },
    receipts: receipts.map((r) => ({
      ...r,
      at: new Date(r.at).toISOString(),
      links: { tx: ex.tx(r.txHash), ...(r.receiptUnit ? { token: ex.token(r.receiptUnit) } : {}), ...(r.paymentTx && /^[0-9a-f]{64}$/.test(r.paymentTx) ? { payment: ex.tx(r.paymentTx) } : {}) },
    })),
    pending: extra.pending ?? [],
  };
}
