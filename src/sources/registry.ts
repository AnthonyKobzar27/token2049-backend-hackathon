// Fans a brief out to every enabled source, with timeouts, a profile cache and stale fallback.

import { createHash } from 'node:crypto';
import type { Config } from '../config';
import type { EventBus, FreelancerSource, SourceRegistry, Store } from '../domain/ports';
import type { Brief, FreelancerProfile, SourceStatus } from '../domain/types';

const norm = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Stable across ordering and case: task, sorted skills, location, language. */
export function queryKey(brief: Brief): string {
  const skills = brief.skills.map(norm).sort();
  return createHash('sha256').update(JSON.stringify([norm(brief.task), skills, norm(brief.location), norm(brief.language)])).digest('hex').slice(0, 32);
}

export function createRegistry(deps: { sources: FreelancerSource[]; store: Store; bus: EventBus; config: Config }): SourceRegistry {
  const { sources, store, bus, config } = deps;

  const safe = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const enabled = (): FreelancerSource[] => {
    const allow = config.SOURCES ? new Set(config.SOURCES.split(',').map((s) => s.trim()).filter(Boolean)) : null;
    return sources.filter((s) => (allow ? allow.has(s.name) : true) && safe(() => s.isEnabled()) === true);
  };

  async function searchOne(source: FreelancerSource, brief: Brief, key: string, limit: number, progress: (m: string) => void): Promise<{ profiles: FreelancerProfile[]; status: SourceStatus }> {
    const started = Date.now();
    const status = (p: Partial<SourceStatus> & { count: number; ok: boolean; cached: boolean }): SourceStatus => ({ source: source.name, ms: Date.now() - started, ...p });
    progress(`Searching ${source.name}…`);

    const fresh = safe(() => store.getCachedProfiles(source.name, key, config.PROFILE_CACHE_TTL_MIN * 60_000));
    if (fresh) {
      progress(`${source.name}: ${fresh.length} profiles`);
      return { profiles: fresh, status: status({ ok: true, cached: true, count: fresh.length }) };
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${config.SOURCE_TIMEOUT_MS} ms`));
          controller.abort();
        }, config.SOURCE_TIMEOUT_MS);
      });
      const found = await Promise.race([source.search(brief, { limit, signal: controller.signal }), timeout]);
      const profiles = found.slice(0, limit);
      safe(() => store.putProfiles(source.name, key, profiles));
      progress(`${source.name}: ${profiles.length} profiles`);
      return { profiles, status: status({ ok: true, cached: false, count: profiles.length }) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stale = safe(() => store.getCachedProfiles(source.name, key, Number.MAX_SAFE_INTEGER)) ?? [];
      progress(`${source.name}: unavailable`);
      return { profiles: stale, status: status({ ok: false, cached: stale.length > 0, count: stale.length, error: message }) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    all: () => [...sources],
    enabled,
    get: (name) => sources.find((s) => s.name === name),
    async searchAll(brief, opts) {
      const key = queryKey(brief);
      const progress = (message: string): void => {
        if (opts.jobId) bus.emit({ type: 'job.progress', jobId: opts.jobId, message });
      };
      const results = await Promise.all(enabled().map((s) => searchOne(s, brief, key, opts.limitPerSource, progress)));
      const seen = new Set<string>();
      const profiles: FreelancerProfile[] = [];
      for (const r of results) {
        for (const p of r.profiles) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          profiles.push(p);
        }
      }
      return { profiles, sources: results.map((r) => r.status) };
    },
  };
}
