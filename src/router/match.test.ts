import { describe, expect, it } from 'vitest';
import type { Brief, FreelancerProfile, Pricing, SuitabilityScore } from '../domain/types';
import { dropReason, quote, rank, ratingScore, totalScore, workingOverlapHours } from './match';
import { matchPlace } from './geo';

const brief = (b: Partial<Brief> = {}): Brief => ({ task: 'build a react dashboard', skills: ['react'], remoteOk: true, ...b });
const prof = (id: string, extra: Partial<FreelancerProfile> = {}): FreelancerProfile => ({
  id: `fiverr:${id}`, platform: 'fiverr', platformId: id, url: `https://x.test/${id}`, name: id, headline: 'h', skills: ['react'], pricing: [], fetchedAt: 0, ...extra,
});
const fixed = (amountUsd: number, deliveryDays?: number): Pricing => ({ kind: 'fixed', amountUsd, deliveryDays });
const hourly = (amountUsd: number, deliveryDays?: number): Pricing => ({ kind: 'hourly', amountUsd, deliveryDays });
const suit = (score: number, reason = 'Strong fit for React dashboards'): SuitabilityScore => ({ score, reason });

describe('quote', () => {
  it('uses amount for fixed and rate x hours for hourly', () => {
    expect(quote(brief({ hoursNeeded: 10 }), prof('a', { pricing: [fixed(300), hourly(20)] }))).toEqual({ quoteUsd: 200, pricingIndex: 1 });
    expect(quote(brief({ hoursNeeded: 20 }), prof('a', { pricing: [fixed(300), hourly(20)] }))).toEqual({ quoteUsd: 300, pricingIndex: 0 });
  });
  it('leaves hourly unquoted without hours but still picks an index', () => {
    expect(quote(brief(), prof('a', { pricing: [hourly(30), hourly(20)] }))).toEqual({ pricingIndex: 1 });
    expect(quote(brief(), prof('a'))).toEqual({});
  });
  it('prefers the cheapest pricing meeting the deadline, else the cheapest overall', () => {
    const p = prof('a', { pricing: [fixed(50, 10), fixed(120, 3), fixed(250, 1)] });
    expect(quote(brief({ deadlineDays: 4 }), p)).toEqual({ quoteUsd: 120, pricingIndex: 1 });
    expect(quote(brief({ deadlineDays: 5 }), prof('b', { pricing: [fixed(80, 10), fixed(50, 12)] }))).toEqual({ quoteUsd: 50, pricingIndex: 1 });
  });
});

describe('hard filters', () => {
  it('drops over budget with 10% tolerance', () => {
    const p = prof('a', { pricing: [fixed(108)] });
    expect(dropReason(brief({ budgetUsd: 100 }), p)).toBeNull();
    expect(dropReason(brief({ budgetUsd: 95 }), p)).toBe('over budget');
  });
  it('drops when all known delivery times miss the deadline', () => {
    expect(dropReason(brief({ deadlineDays: 2 }), prof('a', { pricing: [fixed(10, 5), fixed(20, 3)] }))).toBe('misses deadline');
    expect(dropReason(brief({ deadlineDays: 4 }), prof('a', { pricing: [fixed(10, 5), fixed(20, 3)] }))).toBeNull();
  });
  it('drops on a known language mismatch', () => {
    expect(dropReason(brief({ language: 'de' }), prof('a', { languages: ['en', 'fr'] }))).toBe('language');
    expect(dropReason(brief({ language: 'EN' }), prof('a', { languages: ['en'] }))).toBeNull();
  });
  it('drops on-site work in another country, via aliases', () => {
    const b = brief({ remoteOk: false, location: 'Singapore' });
    expect(dropReason(b, prof('a', { country: 'SG' }))).toBeNull();
    expect(dropReason(b, prof('a', { city: 'Singapore' }))).toBeNull();
    expect(dropReason(b, prof('a', { country: 'IN', city: 'Pune' }))).toBe('location');
    expect(dropReason(brief({ remoteOk: false, location: 'London, UK' }), prof('a', { country: 'United Kingdom' }))).toBeNull();
    expect(dropReason(brief({ remoteOk: false, location: 'USA' }), prof('a', { country: 'GB' }))).toBe('location');
    expect(dropReason(brief({ remoteOk: false, location: 'in Singapore' }), prof('a', { country: 'IN' }))).toBe('location');
    expect(dropReason(brief({ remoteOk: true, location: 'Singapore' }), prof('a', { country: 'IN' }))).toBeNull();
  });
  it('drops when the deadline leaves too few available hours', () => {
    const p = prof('a', { availability: { hoursPerWeek: 10 } });
    expect(dropReason(brief({ hoursNeeded: 40, deadlineDays: 7 }), p)).toBe('not enough hours');
    expect(dropReason(brief({ hoursNeeded: 8, deadlineDays: 7 }), p)).toBeNull();
  });
  it('never drops on unknown fields', () => {
    const b = brief({ budgetUsd: 10, deadlineDays: 1, language: 'ja', remoteOk: false, location: 'Singapore', hoursNeeded: 100 });
    expect(dropReason(b, prof('empty'))).toBeNull();
    expect(dropReason({ ...b, hoursNeeded: undefined }, prof('hourly', { pricing: [hourly(500)] }))).toBeNull();
    expect(dropReason(b, prof('mixed', { pricing: [fixed(5), { kind: 'fixed', amountUsd: 5 }], languages: [] }))).toBeNull();
    expect(dropReason(b, prof('cityonly', { city: 'Pune' }))).toBeNull();
  });
});

describe('geo', () => {
  it('matches aliases and reports unknown rather than elsewhere', () => {
    expect(matchPlace('United States', { country: 'US' })).toBe('match');
    expect(matchPlace('Berlin', { country: 'DE' })).toBe('match');
    expect(matchPlace('Berlin', { country: 'FR' })).toBe('elsewhere');
    expect(matchPlace('Some Village', { country: 'FR' })).toBe('unknown');
  });
});

describe('scores', () => {
  it('shrinks ratings: 4.9 from 300 beats 5.0 from 2', () => {
    expect(ratingScore(4.9, 300)!).toBeGreaterThan(ratingScore(5.0, 2)!);
    expect(ratingScore(4.0, 1000)!).toBeCloseTo(0, 1);
    expect(ratingScore(5.0, 100000)!).toBeCloseTo(1, 1);
    expect(ratingScore(undefined, 5)).toBeNull();
  });
  it('computes timezone overlap', () => {
    expect(workingOverlapHours('Asia/Singapore', 'Asia/Singapore')).toBe(9);
    expect(workingOverlapHours('Asia/Singapore', 'Europe/London')).toBe(1);
    expect(workingOverlapHours('Asia/Singapore', 'America/New_York')).toBe(0);
    expect(workingOverlapHours('Nope/Zone', 'Asia/Tokyo')).toBeNull();
  });
  it('penalises unknown subscores and renormalises', () => {
    const known = { suitability: 0.8, price: 0.8, rating: 0.8, availability: 0.8, speed: 0.8 };
    expect(totalScore(known)).toBeCloseTo(80, 5);
    expect(totalScore({ ...known, speed: null })).toBeCloseTo(78, 5);
    expect(totalScore({ ...known, speed: null, availability: null })).toBeCloseTo(76, 5);
    expect(totalScore({ suitability: null, price: null, rating: null, availability: null, speed: null })).toBe(0);
  });
  it('caps poor suitability at 40', () => {
    expect(totalScore({ suitability: 0.2, price: 1, rating: 1, availability: 1, speed: 1 })).toBe(40);
  });
});

describe('rank', () => {
  const full = (id: string, extra: Partial<FreelancerProfile> = {}) =>
    prof(id, { pricing: [fixed(100, 3)], rating: 4.8, reviewCount: 100, availability: { responseHours: 1, hoursPerWeek: 30 }, ...extra });

  it('puts fully known good profiles above equally good unknown ones', () => {
    const b = brief({ budgetUsd: 300 });
    const good = full('known');
    const sparse = prof('sparse', { pricing: [fixed(100, 3)], rating: 4.8, reviewCount: 100 });
    const s = new Map([[good.id, suit(0.8)], [sparse.id, suit(0.8)]]);
    const out = rank(b, [sparse, good], s, { limit: 5 });
    expect(out.map((c) => c.profile.platformId)).toEqual(['known', 'sparse']);
    expect(out[1]!.subscores.availability).toBeNull();
  });

  it('orders by suitability first and honours exclude', () => {
    const a = full('a');
    const b2 = full('b');
    const s = new Map([[a.id, suit(0.9)], [b2.id, suit(0.3)]]);
    expect(rank(brief(), [b2, a], s, { limit: 5 }).map((c) => c.profile.platformId)).toEqual(['a', 'b']);
    expect(rank(brief(), [b2, a], s, { limit: 5, exclude: [a.id] }).map((c) => c.profile.platformId)).toEqual(['b']);
  });

  it('caps one platform at ceil(limit*0.6) while others are available', () => {
    const many = Array.from({ length: 8 }, (_, i) => full(`f${i}`, { platform: 'fiverr', id: `fiverr:f${i}`, rating: 4.9 }));
    const other = [0, 1].map((i) => full(`u${i}`, { platform: 'upwork', id: `upwork:u${i}`, rating: 4.4 }));
    const out = rank(brief(), [...many, ...other], new Map(), { limit: 5 });
    expect(out).toHaveLength(5);
    expect(out.filter((c) => c.profile.platform === 'fiverr')).toHaveLength(3);
    // when nothing else exists the cap does not starve the list
    expect(rank(brief(), many, new Map(), { limit: 5 })).toHaveLength(5);
  });

  it('filters, dedupes and sorts descending', () => {
    const a = full('a');
    const over = full('over', { pricing: [fixed(9999, 3)] });
    const out = rank(brief({ budgetUsd: 200 }), [a, a, over], new Map(), { limit: 5 });
    expect(out.map((c) => c.profile.platformId)).toEqual(['a']);
  });

  it('writes a plain reason and lists unknowns', () => {
    const p = prof('x', { pricing: [fixed(180, 3)], rating: 4.9, reviewCount: 312, availability: { responseHours: 1 } });
    const [c] = rank(brief(), [p], new Map([[p.id, suit(0.9)]]), { limit: 3 });
    expect(c!.reason).toBe('Strong fit for React dashboards; $180 fixed in 3 days; 4.9 from 312 reviews; replies in about 1 hour.');
    expect(c!.unknowns).toEqual(['hours per week not published on fiverr']);
    expect(c!.quoteUsd).toBe(180);
    expect(c!.pricingIndex).toBe(0);
  });

  it('explains hourly quotes and missing prices', () => {
    const h = prof('h', { pricing: [hourly(25)] });
    const none = prof('n');
    const out = rank(brief({ hoursNeeded: 10 }), [h, none], new Map(), { limit: 3 });
    const byId = Object.fromEntries(out.map((c) => [c.profile.platformId, c]));
    expect(byId.h!.reason).toContain('$25/h (about $250 for 10h)');
    expect(byId.n!.unknowns).toContain('price not published on fiverr');
    expect(byId.n!.reason).toBe('Limited information published.');
  });
});
