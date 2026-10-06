import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import type { Store } from '../domain/ports';
import type { Brief, FreelancerProfile, SuitabilityScore } from '../domain/types';
import { briefKey, clipWords, createSuitabilityScorer, heuristicScore } from './suitability';

const brief: Brief = { task: 'Build a React dashboard', skills: ['react', 'typescript'], remoteOk: true };
const prof = (id: string, skills: string[], headline = 'x'): FreelancerProfile => ({ id: `t:${id}`, platform: 't', platformId: id, url: 'u', name: id, headline, skills, pricing: [], fetchedAt: 0 });

function memStore() {
  const m = new Map<string, SuitabilityScore>();
  const store = {
    getSuitability: (k: string, id: string) => m.get(`${k}|${id}`) ?? null,
    putSuitability: (k: string, id: string, s: SuitabilityScore) => void m.set(`${k}|${id}`, s),
  } as unknown as Store;
  return { store, m };
}

describe('briefKey', () => {
  it('ignores case, whitespace and skill order, but not notes', () => {
    const a = briefKey({ ...brief, skills: ['React', 'typescript'] });
    expect(briefKey({ ...brief, task: '  build a react   dashboard', skills: ['typescript', 'REACT'] })).toBe(a);
    expect(briefKey({ ...brief, notes: 'more' })).not.toBe(a);
  });
});

describe('heuristic fallback', () => {
  it('scores keyword overlap and never throws without an LLM', async () => {
    const { store, m } = memStore();
    const scorer = createSuitabilityScorer({ store, config: testConfig({ ANTHROPIC_API_KEY: undefined }) });
    const out = await scorer.score(brief, [prof('a', ['react', 'typescript']), prof('b', ['logo design'])]);
    expect(out.get('t:a')!.score).toBeGreaterThan(out.get('t:b')!.score);
    expect(out.get('t:a')!.reason).toBe('keyword match');
    expect(out.get('t:b')!.score).toBe(0);
    expect(m.size).toBe(0);
    expect(heuristicScore(brief, prof('a', ['react'])).score).toBeGreaterThan(0);
  });

  it('falls back when a batch fails', async () => {
    const { store } = memStore();
    const scorer = createSuitabilityScorer({ store, config: testConfig() }, async () => { throw new Error('boom'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await scorer.score(brief, [prof('a', ['react'])]);
    expect(out.get('t:a')!.reason).toBe('keyword match');
  });
});

describe('llm path', () => {
  it('batches by 10 with concurrency 3, caches, and only scores uncached profiles', async () => {
    const { store, m } = memStore();
    let active = 0;
    let peak = 0;
    const sizes: number[] = [];
    const llm = vi.fn(async (_b: Brief, batch: FreelancerProfile[]) => {
      active++;
      peak = Math.max(peak, active);
      sizes.push(batch.length);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return new Map(batch.map((p) => [p.id, { score: 0.7, reason: 'llm' }] as const));
    });
    const scorer = createSuitabilityScorer({ store, config: testConfig() }, llm);
    const profiles = Array.from({ length: 35 }, (_, i) => prof(`p${i}`, ['react']));
    const out = await scorer.score(brief, profiles);
    expect(sizes.sort()).toEqual([10, 10, 10, 5]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(out.get('t:p0')).toEqual({ score: 0.7, reason: 'llm' });
    expect(m.size).toBe(35);

    llm.mockClear();
    await scorer.score(brief, [...profiles, prof('new', ['react'])]);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(llm.mock.calls[0]![1].map((p) => p.id)).toEqual(['t:new']);
  });

  it('sends only the 40 best keyword matches to the model when there are more', async () => {
    const { store } = memStore();
    const seen: string[] = [];
    const llm = async (_b: Brief, batch: FreelancerProfile[]) => {
      seen.push(...batch.map((p) => p.id));
      return new Map(batch.map((p) => [p.id, { score: 0.9, reason: 'llm' }] as const));
    };
    const scorer = createSuitabilityScorer({ store, config: testConfig() }, llm);
    const good = Array.from({ length: 40 }, (_, i) => prof(`g${i}`, ['react', 'typescript']));
    const bad = Array.from({ length: 10 }, (_, i) => prof(`b${i}`, ['logo design']));
    const out = await scorer.score(brief, [...bad, ...good]);
    expect(seen).toHaveLength(40);
    expect(seen.every((id) => id.startsWith('t:g'))).toBe(true);
    expect(out.get('t:b0')!.reason).toBe('keyword match');
    expect(out).toHaveProperty('size', 50);
  });

  it('clips reasons to 15 words', () => {
    expect(clipWords('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen.', 15).split(' ')).toHaveLength(15);
  });
});
