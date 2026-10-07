import { describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { createEventBus } from '../domain/events';
import type { FreelancerSource, Store } from '../domain/ports';
import type { Brief, FreelancerProfile, HaasEvent, SuitabilityScore } from '../domain/types';
import { createFakeSource } from '../sources/fake';
import { createRegistry } from '../sources/registry';
import { createRouter } from './router';
import { createSuitabilityScorer } from './suitability';

function setup(llmNotes?: string[]) {
  const cache = new Map<string, FreelancerProfile[]>();
  const store = {
    putProfiles: (s: string, k: string, p: FreelancerProfile[]) => void cache.set(`${s}|${k}`, p),
    getCachedProfiles: (s: string, k: string) => cache.get(`${s}|${k}`) ?? null,
    getSuitability: () => null,
    putSuitability: () => {},
  } as unknown as Store;
  const config = testConfig();
  const bus = createEventBus();
  const events: HaasEvent[] = [];
  bus.on((e) => events.push(e));
  const registry = createRegistry({ sources: [createFakeSource()], store, bus, config });
  // Stub scorer: Singapore on-site fits best when mentioned, otherwise prefer anything with "errand".
  const suitability = createSuitabilityScorer({ store, config }, async (b: Brief, batch) => {
    llmNotes?.push(b.notes ?? '');
    return new Map(batch.map((p) => [p.id, { score: p.skills.includes('errands') ? 0.9 : 0.2, reason: 'Stub fit' } as SuitabilityScore] as const));
  });
  return { router: createRouter({ registry, suitability, bus, config }), events };
}

const brief: Brief = { task: 'on-site errands help', skills: ['errands'], location: 'Singapore', remoteOk: false, budgetUsd: 200, hoursNeeded: 4 };

describe('router', () => {
  it('routes end to end on the fake source, filtering on-site location', async () => {
    const { router, events } = setup();
    const r = await router.route(brief, { jobId: 'j1', limit: 5 });
    expect(r.sources).toHaveLength(1);
    expect(r.candidates.length).toBeGreaterThan(0);
    const ids = r.candidates.map((c) => c.profile.platformId);
    expect(ids).toContain('errand-weijie');
    expect(ids).toContain('errand-siti');
    expect(ids).not.toContain('errand-somchai'); // Bangkok
    expect(r.candidates[0]!.reason).toMatch(/^Stub fit/);
    expect(r.candidates.map((c) => c.score)).toEqual([...r.candidates.map((c) => c.score)].sort((a, b) => b - a));
    const msgs = events.flatMap((e) => (e.type === 'job.progress' ? [e.message] : []));
    expect(msgs.some((m) => /^Picking the best \d+ of \d+ profiles…$/.test(m))).toBe(true);
  });

  it('honours exclude and passes feedback to scoring', async () => {
    const notes: string[] = [];
    const { router } = setup(notes);
    const first = await router.route(brief, { limit: 5 });
    const top = first.candidates[0]!.profile.id;
    const second = await router.route(brief, { limit: 5, exclude: [top], feedback: 'cheaper please' });
    expect(second.candidates.map((c) => c.profile.id)).not.toContain(top);
    expect(notes.some((n) => n.includes('cheaper please'))).toBe(true);
  });

  it('answers within the overall budget when a source and the model are slow', async () => {
    const cache = new Map<string, FreelancerProfile[]>();
    const store = {
      putProfiles: (s: string, k: string, p: FreelancerProfile[]) => void cache.set(`${s}|${k}`, p),
      getCachedProfiles: (s: string, k: string) => cache.get(`${s}|${k}`) ?? null,
      getSuitability: () => null,
      putSuitability: () => {},
    } as unknown as Store;
    const config = testConfig({ SEARCH_BUDGET_MS: 400 });
    const bus = createEventBus();
    const events: HaasEvent[] = [];
    bus.on((e) => events.push(e));
    const slow: FreelancerSource = { name: 'slow', platform: 'slow', kind: 'api', isEnabled: () => true, search: () => new Promise((r) => setTimeout(() => r([]), 5_000)) };
    const registry = createRegistry({ sources: [createFakeSource(), slow], store, bus, config });
    const suitability = createSuitabilityScorer({ store, config }, () => new Promise((r) => setTimeout(() => r(new Map()), 5_000)));
    const router = createRouter({ registry, suitability, bus, config });
    const t0 = Date.now();
    const r = await router.route(brief, { jobId: 'j', limit: 3 });
    expect(Date.now() - t0).toBeLessThan(600);
    expect(r.sources.find((s) => s.source === 'slow')!.late).toBe(true);
    expect(r.candidates[0]!.profile.platformId).toMatch(/^errand-/);
    expect(r.candidates[0]!.reason).toMatch(/^Matches /); // heuristic stood in for the slow model
    const msgs = events.flatMap((e) => (e.type === 'job.progress' ? [e.message] : []));
    expect(msgs).toContain('Ranking without slow (still searching)');
    expect(events.filter((e) => e.type === 'source.done')).toHaveLength(2);
  });

  it('uses the in-person weights, so a nearby person outranks a better-rated one far away', async () => {
    const { router } = setup();
    const r = await router.route({ ...brief, location: 'Marina Bay, Singapore', when: { date: '2026-10-10', window: { start: '14:00', end: '17:00' } } }, { limit: 5 });
    const top = r.candidates[0]!;
    expect(top.profile.city).toBe('Singapore');
    expect(top.subscores.location).toBeGreaterThan(0.5);
    expect(top.subscores.timing).not.toBeUndefined();
    expect(top.reason).toMatch(/km from|in Singapore|based in/);
  });

  it('demo mode: a warm shortlist comes back well inside the 2 s stage budget', async () => {
    const cache = new Map<string, FreelancerProfile[]>();
    const store = {
      putProfiles: (s: string, k: string, p: FreelancerProfile[]) => void cache.set(`${s}|${k}`, p),
      getCachedProfiles: (s: string, k: string) => cache.get(`${s}|${k}`) ?? null,
      getSuitability: () => null,
      putSuitability: () => {},
    } as unknown as Store;
    const config = testConfig({ DEMO_MODE: true, DEMO_BUDGET_MS: 2_000, SOURCES: 'cold' });
    const bus = createEventBus();
    const cold: FreelancerSource = { name: 'cold', platform: 'cold', kind: 'api', isEnabled: () => true, search: () => new Promise(() => {}) };
    const registry = createRegistry({ sources: [createFakeSource(), cold], store, bus, config });
    const router = createRouter({ registry, suitability: createSuitabilityScorer({ store, config: testConfig({ ANTHROPIC_API_KEY: undefined }) }), bus, config });
    const t0 = Date.now();
    const r = await router.route(brief, { limit: 5 });
    expect(Date.now() - t0).toBeLessThan(1_500); // the hung source is cut at 65% of the budget
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.sources.find((s) => s.source === 'cold')!.late).toBe(true);
  });
});
