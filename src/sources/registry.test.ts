import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import { createEventBus } from '../domain/events';
import type { FreelancerSource, Store } from '../domain/ports';
import type { Brief, FreelancerProfile, HaasEvent } from '../domain/types';
import { createRegistry, parseTimeouts, queryKey } from './registry';

const brief: Brief = { task: 'Logo', skills: ['Branding', 'logo'], remoteOk: true, location: 'Berlin', language: 'en' };
const prof = (id: string, platform = 't'): FreelancerProfile => ({ id: `${platform}:${id}`, platform, platformId: id, url: 'u', name: id, headline: 'h', skills: [], pricing: [], fetchedAt: 0 });

function memStore(now: () => number = Date.now) {
  const m = new Map<string, { at: number; profiles: FreelancerProfile[] }>();
  const store = {
    putProfiles: (s: string, k: string, profiles: FreelancerProfile[]) => void m.set(`${s}|${k}`, { at: now(), profiles }),
    getCachedProfiles: (s: string, k: string, maxAge: number) => {
      const e = m.get(`${s}|${k}`);
      return e && now() - e.at <= maxAge ? e.profiles : null;
    },
  } as unknown as Store;
  return { store, m };
}
const source = (name: string, search: FreelancerSource['search'], enabled = true): FreelancerSource => ({ name, platform: name, kind: 'api', isEnabled: () => enabled, search });

describe('queryKey', () => {
  it('is stable across case and skill order', () => {
    expect(queryKey(brief)).toBe(queryKey({ ...brief, task: ' logo ', skills: ['LOGO', 'branding'], location: 'berlin' }));
    expect(queryKey(brief)).not.toBe(queryKey({ ...brief, language: 'de' }));
  });
});

describe('registry', () => {
  it('enabled() honours isEnabled and SOURCES', () => {
    const a = source('a', async () => []);
    const b = source('b', async () => []);
    const c = source('c', async () => [], false);
    const mk = (SOURCES?: string) => createRegistry({ sources: [a, b, c], store: memStore().store, bus: createEventBus(), config: testConfig({ SOURCES }) });
    expect(mk().enabled().map((s) => s.name)).toEqual(['a', 'b']);
    expect(mk('b, c').enabled().map((s) => s.name)).toEqual(['b']);
    expect(mk().get('c')).toBe(c);
    expect(mk().all()).toHaveLength(3);
  });

  it('searches in parallel, caches, dedupes by id and emits progress', async () => {
    const search = vi.fn(async () => [prof('1'), prof('1'), prof('2')]);
    const other = source('o', async () => [prof('1', 'o'), prof('3', 'o')]);
    const { store } = memStore();
    const bus = createEventBus();
    const events: HaasEvent[] = [];
    bus.on((e) => events.push(e));
    const reg = createRegistry({ sources: [source('t', search), other], store, bus, config: testConfig() });
    const r1 = await reg.searchAll(brief, { limitPerSource: 25, jobId: 'job1' });
    expect(r1.profiles.map((p) => p.id)).toEqual(['t:1', 't:2', 'o:1', 'o:3']);
    expect(r1.sources.map((s) => [s.source, s.ok, s.cached, s.count])).toEqual([['t', true, false, 3], ['o', true, false, 2]]);
    const msgs = events.flatMap((e) => (e.type === 'job.progress' ? [e.message] : []));
    expect(msgs).toContain('Searching t…');
    expect(msgs).toContain('t: 3 profiles');

    const r2 = await reg.searchAll(brief, { limitPerSource: 25 });
    expect(search).toHaveBeenCalledTimes(1);
    expect(r2.sources.every((s) => s.cached && s.ok)).toBe(true);
  });

  it('serves an expired cache at once and refreshes it in the background', async () => {
    let t = 0;
    const { store } = memStore(() => t);
    let fail = false;
    let calls = 0;
    const flaky = source('f', async () => {
      calls++;
      if (fail) throw new Error('down');
      return [prof(`x${calls}`, 'f')];
    });
    const reg = createRegistry({ sources: [flaky, source('dead', async () => { throw new Error('nope'); })], store, bus: createEventBus(), config: testConfig({ PROFILE_CACHE_TTL_MIN: 1 }) });
    await reg.searchAll(brief, { limitPerSource: 5 });
    t = 10 * 60_000; // past the TTL
    const r = await reg.searchAll(brief, { limitPerSource: 5 });
    expect(r.sources.find((s) => s.source === 'f')).toMatchObject({ ok: true, cached: true, stale: true, count: 1 });
    expect(r.profiles.map((p) => p.id)).toEqual(['f:x1']);
    expect(r.sources.find((s) => s.source === 'dead')).toMatchObject({ ok: false, cached: false, count: 0, error: 'nope' });
    await reg.settle();
    expect(calls).toBe(2);
    expect((await reg.searchAll(brief, { limitPerSource: 5 })).profiles.map((p) => p.id)).toEqual(['f:x2']);

    // A failing refresh keeps the old entry in service.
    fail = true;
    t = 20 * 60_000;
    const r3 = await reg.searchAll(brief, { limitPerSource: 5 });
    await reg.settle();
    expect(r3.profiles.map((p) => p.id)).toEqual(['f:x2']);
    expect(r3.sources[0]).toMatchObject({ ok: true, stale: true });
  });

  it('serves a rephrased brief with the same skills from cache', async () => {
    const search = vi.fn(async () => [prof('1')]);
    const reg = createRegistry({ sources: [source('t', search)], store: memStore().store, bus: createEventBus(), config: testConfig() });
    await reg.searchAll(brief, { limitPerSource: 5 });
    const r = await reg.searchAll({ ...brief, task: 'A logo for my bakery' }, { limitPerSource: 5 });
    expect(r.profiles.map((p) => p.id)).toEqual(['t:1']);
    expect(r.sources[0]).toMatchObject({ ok: true, cached: true });
    await reg.settle();
    expect(search).toHaveBeenCalledTimes(2); // refreshed behind for the new wording
  });

  it('times out slow sources, aborting the signal', async () => {
    let aborted = false;
    const slow = source('slow', (_b, o) => new Promise(() => { o.signal?.addEventListener('abort', () => (aborted = true)); }));
    const reg = createRegistry({ sources: [slow], store: memStore().store, bus: createEventBus(), config: testConfig({ SOURCE_TIMEOUT_MS: 20 }) });
    const r = await reg.searchAll(brief, { limitPerSource: 5 });
    expect(r.sources[0]).toMatchObject({ ok: false, count: 0 });
    expect(r.sources[0]!.error).toMatch(/timed out/);
    expect(aborted).toBe(true);
  });

  it('applies limitPerSource', async () => {
    const reg = createRegistry({ sources: [source('t', async () => [prof('1'), prof('2'), prof('3')])], store: memStore().store, bus: createEventBus(), config: testConfig() });
    expect((await reg.searchAll(brief, { limitPerSource: 2 })).profiles).toHaveLength(2);
  });
});

describe('search budget', () => {
  const later = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms));

  it('ranks what returned in time, marks late sources, and caches them for next time', async () => {
    const { store } = memStore();
    const bus = createEventBus();
    const events: HaasEvent[] = [];
    bus.on((e) => events.push(e));
    const fast = source('fast', async () => [prof('a', 'fast')]);
    const slow = source('slow', () => later(120, [prof('b', 'slow')]));
    const reg = createRegistry({ sources: [fast, slow], store, bus, config: testConfig() });
    const t0 = Date.now();
    const r = await reg.searchAll(brief, { limitPerSource: 5, jobId: 'j', budgetMs: 30 });
    expect(Date.now() - t0).toBeLessThan(100);
    expect(r.profiles.map((p) => p.id)).toEqual(['fast:a']);
    expect(r.sources.find((s) => s.source === 'slow')).toMatchObject({ ok: false, late: true, count: 0 });
    const done = events.flatMap((e) => (e.type === 'source.done' ? [e] : []));
    expect(done.map((e) => [e.jobId, e.status.source, e.status.late ?? false])).toEqual([['j', 'fast', false], ['j', 'slow', true]]);

    await reg.settle();
    const msgs = events.flatMap((e) => (e.type === 'job.progress' ? [e.message] : []));
    expect(msgs).toContain('slow: 1 profiles (late, ready for the next search)');
    const r2 = await reg.searchAll(brief, { limitPerSource: 5, budgetMs: 30 });
    expect(r2.profiles.map((p) => p.id).sort()).toEqual(['fast:a', 'slow:b']);
  });

  it('defaults to SEARCH_BUDGET_MS and honours per-source timeouts', async () => {
    let aborted = false;
    const hang = source('hang', (_b, o) => new Promise(() => { o.signal?.addEventListener('abort', () => (aborted = true)); }));
    const reg = createRegistry({ sources: [hang], store: memStore().store, bus: createEventBus(), config: testConfig({ SEARCH_BUDGET_MS: 40, SOURCE_TIMEOUTS: 'hang:60' }) });
    const r = await reg.searchAll(brief, { limitPerSource: 5 });
    expect(r.sources[0]).toMatchObject({ late: true });
    await reg.settle();
    expect(aborted).toBe(true);
    expect(parseTimeouts('a:100, b:x ,c:5')).toEqual(new Map([['a', 100], ['c', 5]]));
  });

  it('runs sources in parallel, not one after another', async () => {
    const mk = (n: string) => source(n, () => later(40, [prof('1', n)]));
    const reg = createRegistry({ sources: [mk('a'), mk('b'), mk('c')], store: memStore().store, bus: createEventBus(), config: testConfig() });
    const t0 = Date.now();
    const r = await reg.searchAll(brief, { limitPerSource: 5, budgetMs: 1000 });
    expect(Date.now() - t0).toBeLessThan(110);
    expect(r.profiles).toHaveLength(3);
  });

  it('keeps browser sources opt-in and never waits on them', async () => {
    const browser: FreelancerSource = { ...source('fiverr', () => later(80, [prof('g', 'fiverr')])), kind: 'browser' };
    const api = source('api', async () => [prof('a', 'api')]);
    const off = createRegistry({ sources: [browser, api], store: memStore().store, bus: createEventBus(), config: testConfig() });
    expect(off.enabled().map((s) => s.name)).toEqual(['api']);

    const reg = createRegistry({ sources: [browser, api], store: memStore().store, bus: createEventBus(), config: testConfig({ BROWSER_SOURCES: true }) });
    const t0 = Date.now();
    const r = await reg.searchAll(brief, { limitPerSource: 5, budgetMs: 5000 });
    expect(Date.now() - t0).toBeLessThan(60);
    expect(r.sources.find((s) => s.source === 'fiverr')).toMatchObject({ late: true, count: 0 });
    await reg.settle();
    const r2 = await reg.searchAll(brief, { limitPerSource: 5 });
    expect(r2.profiles.map((p) => p.id)).toContain('fiverr:g');
  });

  it('demo mode pins the cache and caps the budget', async () => {
    let t = 0;
    const { store } = memStore(() => t);
    const search = vi.fn(async () => [prof('1')]);
    const hang = source('hang', () => new Promise(() => {}));
    const reg = createRegistry({ sources: [source('t', search), hang], store, bus: createEventBus(), config: testConfig({ DEMO_MODE: true, DEMO_BUDGET_MS: 30, SOURCE_TIMEOUT_MS: 50 }) });
    await reg.searchAll(brief, { limitPerSource: 5, budgetMs: 10_000 });
    t = 1e12; // long expired
    const t0 = Date.now();
    const r = await reg.searchAll(brief, { limitPerSource: 5, budgetMs: 10_000 });
    expect(Date.now() - t0).toBeLessThan(100);
    expect(r.sources.find((s) => s.source === 't')).toMatchObject({ ok: true, cached: true });
    expect(r.sources.find((s) => s.source === 't')!.stale).toBeUndefined();
    await reg.settle();
    expect(search).toHaveBeenCalledTimes(1); // pinned: no refresh
  });
});
