import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import { createEventBus } from '../domain/events';
import type { FreelancerSource, Store } from '../domain/ports';
import type { Brief, FreelancerProfile, HaasEvent } from '../domain/types';
import { createRegistry, queryKey } from './registry';

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

  it('falls back to stale cache on failure, or to nothing', async () => {
    let t = 0;
    const { store } = memStore(() => t);
    let fail = false;
    const flaky = source('f', async () => {
      if (fail) throw new Error('down');
      return [prof('x', 'f')];
    });
    const reg = createRegistry({ sources: [flaky, source('dead', async () => { throw new Error('nope'); })], store, bus: createEventBus(), config: testConfig({ PROFILE_CACHE_TTL_MIN: 1 }) });
    await reg.searchAll(brief, { limitPerSource: 5 });
    fail = true;
    t = 10 * 60_000; // past the TTL
    const r = await reg.searchAll(brief, { limitPerSource: 5 });
    const f = r.sources.find((s) => s.source === 'f')!;
    expect(f).toMatchObject({ ok: false, cached: true, count: 1, error: 'down' });
    expect(r.profiles.map((p) => p.id)).toEqual(['f:x']);
    expect(r.sources.find((s) => s.source === 'dead')).toMatchObject({ ok: false, cached: false, count: 0, error: 'nope' });
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

  it('uses a source timeout lower than the global one, without slowing the others', async () => {
    const slow: FreelancerSource = { ...source('slow', () => new Promise(() => {})), timeoutMs: 20 };
    const fast = source('fast', async () => [prof('a', 'fast')]);
    const reg = createRegistry({ sources: [slow, fast], store: memStore().store, bus: createEventBus(), config: testConfig({ SOURCE_TIMEOUT_MS: 60_000 }) });
    const started = Date.now();
    const r = await reg.searchAll(brief, { limitPerSource: 5 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.sources.find((s) => s.source === 'slow')!.error).toMatch(/timed out after 20 ms/);
    expect(r.profiles.map((p) => p.id)).toEqual(['fast:a']);
  });

  it('applies limitPerSource', async () => {
    const reg = createRegistry({ sources: [source('t', async () => [prof('1'), prof('2'), prof('3')])], store: memStore().store, bus: createEventBus(), config: testConfig() });
    expect((await reg.searchAll(brief, { limitPerSource: 2 })).profiles).toHaveLength(2);
  });
});
