import { describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { createEventBus } from '../domain/events';
import type { Store } from '../domain/ports';
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
    expect(msgs.some((m) => /^Scoring \d+ profiles…$/.test(m))).toBe(true);
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
});
