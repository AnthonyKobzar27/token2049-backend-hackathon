// On-chain identity in ranking: a bounded, additive boost and a reason note, read from cache only.
import { describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { createEventBus } from '../domain/events';
import type { SourceRegistry, SuitabilityScorer } from '../domain/ports';
import type { Brief, FreelancerProfile, SuitabilityScore } from '../domain/types';
import { onchainBoost, onchainReason, rank, type OnChainSignal } from './match';
import { createRouter } from './router';

const brief: Brief = { task: 'build a react dashboard', skills: ['react'], remoteOk: true };
const prof = (id: string): FreelancerProfile => ({
  id: `fiverr:${id}`, platform: 'fiverr', platformId: id, url: `https://x.test/${id}`, name: id, headline: 'h', skills: ['react'],
  pricing: [{ kind: 'fixed', amountUsd: 100, deliveryDays: 3 }], rating: 4.8, reviewCount: 100, availability: { responseHours: 1, hoursPerWeek: 30 }, fetchedAt: 0,
});
const suit = (score: number): SuitabilityScore => ({ score, reason: 'Fit' });

describe('onchainBoost', () => {
  it('is zero without a confirmed credential and bounded with one', () => {
    expect(onchainBoost(undefined)).toBe(0);
    expect(onchainBoost({ verified: false, jobsCompleted: 50, avgRating: 5 })).toBe(0);
    expect(onchainBoost({ verified: true, jobsCompleted: 0 })).toBe(3);
    expect(onchainBoost({ verified: true, jobsCompleted: 7 })).toBe(6.5);
    expect(onchainBoost({ verified: true, jobsCompleted: 100, avgRating: 5 })).toBe(10);
    expect(onchainBoost({ verified: true, jobsCompleted: 4, avgRating: 2 })).toBe(3);
  });
  it('explains itself in one phrase', () => {
    expect(onchainReason({ verified: true, jobsCompleted: 7 })).toBe('on-chain verified, 7 jobs completed on HAAS');
    expect(onchainReason({ verified: true, jobsCompleted: 1 })).toBe('on-chain verified, 1 job completed on HAAS');
    expect(onchainReason({ verified: true, jobsCompleted: 0 })).toBe('on-chain verified HAAS worker');
    expect(onchainReason({ verified: false, jobsCompleted: 7 })).toBeNull();
  });
});

describe('rank with on-chain signals', () => {
  it('lifts a verified worker above an otherwise identical one and says why', () => {
    const a = prof('a');
    const b = prof('b');
    const s = new Map([[a.id, suit(0.8)], [b.id, suit(0.8)]]);
    const onchain = new Map<string, OnChainSignal>([[b.id, { verified: true, jobsCompleted: 7 }]]);
    const out = rank(brief, [a, b], s, { limit: 5, onchain });
    expect(out.map((c) => c.profile.platformId)).toEqual(['b', 'a']);
    expect(out[0]!.score - out[1]!.score).toBeCloseTo(6.5, 1);
    expect(out[0]!.reason).toContain('on-chain verified, 7 jobs completed on HAAS');
    expect(out[1]!.reason).not.toContain('on-chain');
  });

  it('never rescues a poor fit', () => {
    const a = prof('a');
    const b = prof('b');
    const s = new Map([[a.id, suit(0.6)], [b.id, suit(0.1)]]);
    const onchain = new Map<string, OnChainSignal>([[b.id, { verified: true, jobsCompleted: 100, avgRating: 5 }]]);
    const out = rank(brief, [a, b], s, { limit: 5, onchain });
    expect(out[0]!.profile.platformId).toBe('a');
    expect(out[1]!.score).toBe(rank(brief, [b], s, { limit: 5 })[0]!.score);
  });
});

describe('router with identity', () => {
  const pool = [prof('a'), prof('b')];
  const registry = { searchAll: async () => ({ profiles: pool, sources: [] }) } as unknown as SourceRegistry;
  const suitability: SuitabilityScorer = { score: async (_b, ps) => new Map(ps.map((p) => [p.id, suit(0.8)])) };
  const base = { registry, suitability, bus: createEventBus(), config: testConfig() };

  it('uses cached signals', async () => {
    const router = createRouter({ ...base, identity: { signals: () => new Map([['fiverr:b', { verified: true, jobsCompleted: 2 }]]) } });
    const r = await router.route(brief, { limit: 5 });
    expect(r.candidates[0]!.profile.id).toBe('fiverr:b');
  });

  it('ranks without identity when the lookup throws', async () => {
    const router = createRouter({ ...base, identity: { signals: () => { throw new Error('boom'); } } });
    const r = await router.route(brief, { limit: 5 });
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates.every((c) => !c.reason.includes('on-chain'))).toBe(true);
  });
});
