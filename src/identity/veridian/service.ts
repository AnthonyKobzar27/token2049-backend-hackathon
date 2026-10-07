// Worker onboarding and the credential-verified cache the router reads.
//
// Onboarding (one session per worker, the session id is the capability the worker holds):
//   start()   operator has verified the worker's platforms -> session with the HAAS issuer OOBI + QR
//   connect() worker gives their Veridian wallet OOBI -> HAAS resolves it, issues + IPEX-grants
//   get()     polls for the wallet's IPEX admit -> 'admitted'
//
// Router cache: signals() is synchronous and cache-only. Workers HAAS issued to (or who presented a
// credential) are re-verified in the background with a short timeout; ranking never waits on KERIA.

import { randomBytes } from 'node:crypto';
import type { Store } from '../../domain/ports';
import type { OnChainSignal } from '../types';
import type { PresentedCredential, VerificationResult, VeridianCredential, VeridianCredentialIssuer, WorkerAttributes } from './issuer';

export type OnboardingStatus = 'awaiting-wallet' | 'issuing' | 'granted' | 'admitted' | 'failed';

export interface OnboardingSession {
  id: string;
  workerId: string;
  platformsVerified: string[];
  verificationMethod: string;
  cardanoReputationAsset?: string;
  status: OnboardingStatus;
  issuerOobi: string;
  holderAid?: string;
  credentialSaid?: string;
  grantSaid?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CredentialCheck {
  result: VerificationResult;
  /** Last check that reached a verdict (valid or not); errors and timeouts do not move it. */
  checkedAt: number;
  error?: string;
  errorAt?: number;
}

export interface VeridianService {
  readonly issuer: VeridianCredentialIssuer;
  start(input: Omit<WorkerAttributes, 'issuedAt'>): Promise<OnboardingSession>;
  connect(sessionId: string, walletOobi: string): Promise<OnboardingSession>;
  get(sessionId: string): Promise<OnboardingSession | undefined>;
  /** Verifies a presented credential or a known SAID; a valid result marks `workerId` (or the credential's workerId) as credential-verified. */
  verify(input: { workerId?: string; said?: string } & Partial<PresentedCredential>, opts?: { timeoutMs?: number }): Promise<VerificationResult>;
  credentialOf(workerId: string): VeridianCredential | undefined;
  checkOf(workerId: string): CredentialCheck | undefined;
  /** Synchronous, cache-only; schedules background re-verification for stale entries. */
  signals(workerIds: string[]): Map<string, OnChainSignal>;
  /** Reads IPEX presentations sent to HAAS and caches their verdicts. */
  pollPresentations(): Promise<number>;
  startPolling(intervalMs?: number): void;
  stop(): void;
}

export interface VeridianServiceDeps {
  issuer: VeridianCredentialIssuer;
  store: Store;
  /** Re-verify cached verdicts older than this. */
  ttlMs?: number;
  /** A valid verdict survives failed refreshes (KERIA down) for this long. */
  maxStaleMs?: number;
  /** Deadline for a background or API verification. */
  verifyTimeoutMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

const K = {
  session: (id: string) => `veridian:session:${id}`,
  cred: (w: string) => `veridian:cred:${w}`,
  said: (w: string) => `veridian:said:${w}`,
  check: (w: string) => `veridian:check:${w}`,
  workers: 'veridian:workers',
};

/** verifySaid reasons that are verdicts about the credential itself, not about reaching KERIA. */
const DEFINITE = /unknown credential|not a HAAS Verified Worker credential|is not trusted|revoked|malformed credential|SAID does not match/i;

export function createVeridianService(deps: VeridianServiceDeps): VeridianService {
  const { issuer, store } = deps;
  const ttl = deps.ttlMs ?? 30 * 60_000;
  const maxStale = deps.maxStaleMs ?? 24 * 60 * 60_000;
  const timeout = deps.verifyTimeoutMs ?? 2_000;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.log(`[veridian] ${m}`));
  const refreshing = new Map<string, Promise<void>>();
  const issuing = new Map<string, Promise<void>>();
  let timer: NodeJS.Timeout | undefined;
  let polling = false;

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

  function remember(workerId: string, said: string) {
    store.setKv(K.said(workerId), said);
    const all = getJson<string[]>(K.workers) ?? [];
    if (!all.includes(workerId)) setJson(K.workers, [...all, workerId]);
  }

  function record(workerId: string, result: VerificationResult) {
    if (result.said) remember(workerId, result.said);
    setJson(K.check(workerId), { result, checkedAt: result.checkedAt } satisfies CredentialCheck);
  }

  function save(s: OnboardingSession) {
    s.updatedAt = now();
    setJson(K.session(s.id), s);
    return s;
  }

  function refresh(workerId: string): Promise<void> {
    const running = refreshing.get(workerId);
    if (running) return running;
    const said = store.getKv(K.said(workerId));
    if (!said) return Promise.resolve();
    const p = issuer
      .verifySaid(said, { timeoutMs: timeout })
      .then((result) => {
        // Only a definite answer replaces the last verdict; anything else (timeout, KERIA 5xx, registry
        // state not readable) is noted as an error and the worker keeps their label within maxStaleMs.
        if (!result.valid && !result.registryState && !DEFINITE.test(result.reason ?? '')) throw new Error(result.reason ?? 'verification failed');
        const prev = getJson<CredentialCheck>(K.check(workerId));
        record(workerId, { ...result, holderProven: result.holderProven || (!!prev?.result.holderProven && prev.result.said === result.said) });
      })
      .catch((err: Error) => {
        const prev = getJson<CredentialCheck>(K.check(workerId));
        if (prev) setJson(K.check(workerId), { ...prev, error: err.message, errorAt: now() });
        log(`re-verifying ${workerId} failed: ${err.message}`);
      })
      .finally(() => refreshing.delete(workerId));
    refreshing.set(workerId, p);
    return p;
  }

  async function issueFor(s: OnboardingSession, walletOobi: string) {
    try {
      const holderAid = await issuer.resolveHolder(walletOobi, `worker-${s.workerId}`);
      s.holderAid = holderAid;
      save(s);
      const cred = await issuer.issueToHolder(holderAid, {
        workerId: s.workerId,
        platformsVerified: s.platformsVerified,
        verificationMethod: s.verificationMethod,
        ...(s.cardanoReputationAsset ? { cardanoReputationAsset: s.cardanoReputationAsset } : {}),
      });
      setJson(K.cred(s.workerId), cred);
      record(s.workerId, { valid: true, said: cred.said, issuerAid: cred.issuerAid, holderAid, workerId: s.workerId, platformsVerified: s.platformsVerified, verificationMethod: s.verificationMethod, registryState: 'iss', holderProven: false, checkedAt: now() });
      Object.assign(s, { status: 'granted', credentialSaid: cred.said, grantSaid: cred.grantSaid });
      delete s.error;
      save(s);
      log(`issued ${cred.said} to ${s.workerId} (${holderAid})`);
    } catch (err) {
      Object.assign(s, { status: 'failed', error: (err as Error).message });
      save(s);
      log(`issuing to ${s.workerId} failed: ${(err as Error).message}`);
    }
  }

  const svc: VeridianService = {
    issuer,

    async start(input) {
      if (!input.workerId?.trim()) throw new Error('workerId is required');
      if (!Array.isArray(input.platformsVerified) || input.platformsVerified.some((p) => typeof p !== 'string')) throw new Error('platformsVerified must be a list of platform names');
      if (!input.verificationMethod?.trim()) throw new Error('verificationMethod is required');
      const issuerOobi = await issuer.issuerOobi();
      const t = now();
      return save({
        id: randomBytes(16).toString('base64url'),
        workerId: input.workerId.trim(),
        platformsVerified: input.platformsVerified,
        verificationMethod: input.verificationMethod.trim(),
        ...(input.cardanoReputationAsset ? { cardanoReputationAsset: input.cardanoReputationAsset } : {}),
        status: 'awaiting-wallet',
        issuerOobi,
        createdAt: t,
        updatedAt: t,
      });
    },

    async connect(sessionId, walletOobi) {
      const s = getJson<OnboardingSession>(K.session(sessionId));
      if (!s) throw new Error('unknown onboarding session');
      if (s.status === 'granted' || s.status === 'admitted') return s;
      if (s.status === 'issuing') return s;
      if (typeof walletOobi !== 'string' || !walletOobi.trim()) throw new Error('oobi is required');
      s.status = 'issuing';
      save(s);
      const p = issueFor(s, walletOobi.trim()).finally(() => issuing.delete(sessionId));
      issuing.set(sessionId, p);
      await p;
      return getJson<OnboardingSession>(K.session(sessionId)) ?? s;
    },

    async get(sessionId) {
      const s = getJson<OnboardingSession>(K.session(sessionId));
      if (!s) return undefined;
      if (s.status === 'granted' && s.grantSaid) {
        try {
          if (await issuer.admitted(s.grantSaid)) {
            s.status = 'admitted';
            save(s);
          }
        } catch (err) {
          log(`checking admit for ${s.workerId} failed: ${(err as Error).message}`);
        }
      }
      return s;
    },

    async verify(input, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? timeout;
      let result: VerificationResult;
      if (input.acdc && input.iss) {
        result = await withDeadline(issuer.verify({ acdc: input.acdc, iss: input.iss }, { timeoutMs }), timeoutMs, input.acdc);
      } else {
        const said = input.said ?? (input.workerId ? store.getKv(K.said(input.workerId)) ?? undefined : undefined);
        if (!said) return { valid: false, reason: 'no credential to verify: send {acdc, iss} or {said}', holderProven: false, checkedAt: now() };
        result = await withDeadline(issuer.verifySaid(said, { timeoutMs }), timeoutMs, { d: said });
      }
      if (input.workerId && result.workerId && input.workerId !== result.workerId) {
        return { ...result, valid: false, reason: `credential belongs to ${result.workerId}, not ${input.workerId}` };
      }
      const workerId = result.workerId ?? input.workerId;
      if (workerId && result.said && (result.valid || result.registryState)) record(workerId, result);
      return result;
    },

    credentialOf: (w) => getJson<VeridianCredential>(K.cred(w)),
    checkOf: (w) => getJson<CredentialCheck>(K.check(w)),

    signals(workerIds) {
      const out = new Map<string, OnChainSignal>();
      const t = now();
      for (const id of workerIds) {
        const check = getJson<CredentialCheck>(K.check(id));
        if (!check) continue;
        if (t - check.checkedAt > ttl && (!check.errorAt || t - check.errorAt > Math.min(ttl, 60_000))) void refresh(id);
        if (check.result.valid && t - check.checkedAt <= maxStale) out.set(id, { verified: true, jobsCompleted: 0, veridian: true });
      }
      return out;
    },

    async pollPresentations() {
      if (polling) return 0;
      polling = true;
      try {
        const found = await issuer.presentations({ timeoutMs: timeout });
        for (const p of found) {
          const w = p.result.workerId;
          if (w && p.result.said) record(w, p.result);
          log(`presentation from ${p.sender}: ${p.result.valid ? `valid, ${w}` : `rejected (${p.result.reason})`}`);
        }
        return found.length;
      } finally {
        polling = false;
      }
    },

    startPolling(intervalMs = 15_000) {
      if (timer) return;
      timer = setInterval(() => {
        svc.pollPresentations().catch((err) => log(`polling presentations failed: ${(err as Error).message}`));
      }, intervalMs);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };

  function withDeadline(p: Promise<VerificationResult>, ms: number, acdc: Record<string, any>): Promise<VerificationResult> {
    let t: NodeJS.Timeout | undefined;
    const late = new Promise<VerificationResult>((resolve) => {
      t = setTimeout(() => resolve({ valid: false, reason: `verification timed out after ${ms} ms`, holderProven: false, checkedAt: now(), ...(acdc?.d ? { said: acdc.d } : {}) }), ms + 250);
    });
    return Promise.race([p.catch((err: Error) => ({ valid: false, reason: err.message, holderProven: false, checkedAt: now() }) as VerificationResult), late]).finally(() => clearTimeout(t));
  }

  return svc;
}

/** Merges per-worker signals from several sources (Cardano CIP-68 registry, Veridian). */
export function combineSignals(...sources: Array<{ signals(ids: string[]): Map<string, OnChainSignal> } | undefined | null>) {
  return {
    signals(ids: string[]): Map<string, OnChainSignal> {
      const out = new Map<string, OnChainSignal>();
      for (const src of sources) {
        if (!src) continue;
        let m: Map<string, OnChainSignal>;
        try {
          m = src.signals(ids);
        } catch (err) {
          console.error('[identity] signal source failed:', err);
          continue;
        }
        for (const [id, sig] of m) {
          const prev = out.get(id);
          if (!prev) {
            out.set(id, { ...sig });
            continue;
          }
          const best = sig.jobsCompleted > prev.jobsCompleted ? sig : prev;
          const merged: OnChainSignal = { verified: prev.verified || sig.verified, jobsCompleted: best.jobsCompleted };
          if (best.avgRating !== undefined) merged.avgRating = best.avgRating;
          if (prev.veridian || sig.veridian) merged.veridian = true;
          if (prev.cardano || sig.cardano) merged.cardano = true;
          out.set(id, merged);
        }
      }
      return out;
    },
  };
}
