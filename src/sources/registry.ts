// Fans a brief out to every enabled source in parallel and answers within a time budget.
// Cache is stale-while-revalidate: an expired entry is served at once and refreshed in the
// background. A source that misses the budget is marked late and keeps going in the
// background (up to its own timeout) so the next search has it. Browser sources never block.

import { createHash } from 'node:crypto';
import type { Config } from '../config';
import type { EventBus, FreelancerSource, SourceRegistry, Store } from '../domain/ports';
import type { Brief, FreelancerProfile, SourceStatus } from '../domain/types';

const norm = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** What sources filter or price on besides the words: a brief that differs here gets different results. */
const scope = (brief: Brief) => [brief.remoteOk, brief.budgetUsd ?? null, brief.radiusKm ?? null, brief.hoursNeeded ?? null];

/** Stable across ordering and case: task, sorted skills, location, language and scope. */
export function queryKey(brief: Brief): string {
  const skills = brief.skills.map(norm).sort();
  return createHash('sha256').update(JSON.stringify([norm(brief.task), skills, norm(brief.location), norm(brief.language), ...scope(brief)])).digest('hex').slice(0, 32);
}

/**
 * Looser key: skills, location and language without the task wording. Lets a rephrased brief
 * (the intake model words the task differently each time) still hit a warm cache.
 */
export function skillsKey(brief: Brief): string | null {
  const skills = brief.skills.map(norm).sort();
  // Without skills only the task wording tells briefs apart: no fallback, or every such brief would share one entry.
  if (skills.length === 0) return null;
  return `s:${createHash('sha256').update(JSON.stringify([skills, norm(brief.location), norm(brief.language), ...scope(brief)])).digest('hex').slice(0, 30)}`;
}

/** Parses "freelancer:8000, rentahuman:5000". */
export function parseTimeouts(spec: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of (spec ?? '').split(',')) {
    const [name, ms] = part.split(':').map((s) => s.trim());
    const n = Number(ms);
    if (name && Number.isFinite(n) && n > 0) out.set(name, n);
  }
  return out;
}

export interface Registry extends SourceRegistry {
  /** Resolves when every background refresh started so far has finished (tests, cache warming). */
  settle(): Promise<void>;
}

type Fetched = { ok: true; profiles: FreelancerProfile[] } | { ok: false; error: string };

export function createRegistry(deps: { sources: FreelancerSource[]; store: Store; bus: EventBus; config: Config }): Registry {
  const { sources, store, bus, config } = deps;
  const timeouts = parseTimeouts(config.SOURCE_TIMEOUTS);
  const inflight = new Map<string, Promise<Fetched>>();

  const safe = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const explicitlyListed = (): Set<string> | null => (config.SOURCES ? new Set(config.SOURCES.split(',').map((s) => s.trim()).filter(Boolean)) : null);
  const enabled = (): FreelancerSource[] => {
    const allow = explicitlyListed();
    return sources.filter((s) => {
      // Demo mode always keeps the fixture source, so the stage never shows an empty shortlist.
      const demoFixture = config.DEMO_MODE && s.kind === 'fixture';
      if (!demoFixture && (allow ? !allow.has(s.name) : s.kind === 'browser' && !config.BROWSER_SOURCES)) return false;
      return safe(() => s.isEnabled()) === true;
    });
  };

  const cacheGet = (source: string, keys: string[], maxAgeMs: number): FreelancerProfile[] | null => {
    for (const k of keys) {
      const hit = safe(() => store.getCachedProfiles(source, k, maxAgeMs));
      // An empty answer counts only for this exact brief, never as another wording's results.
      if (hit && (hit.length > 0 || k === keys[0])) return hit;
    }
    return null;
  };

  /** One live request, deduplicated per (source, key), capped by the source's own timeout; fills the cache. */
  function fetchLive(source: FreelancerSource, brief: Brief, keys: string[], limit: number, onLate?: (r: Fetched) => void): Promise<Fetched> {
    const id = `${source.name}|${keys[0]}`;
    let p = inflight.get(id);
    if (!p) {
      // An explicit SOURCE_TIMEOUTS entry wins; otherwise the lower of the source's own cap and SOURCE_TIMEOUT_MS.
      const cap = timeouts.get(source.name) ?? Math.min(config.SOURCE_TIMEOUT_MS, source.timeoutMs && source.timeoutMs > 0 ? source.timeoutMs : Infinity);
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`timed out after ${cap} ms`));
          controller.abort();
        }, cap);
        (timer as { unref?: () => void }).unref?.();
      });
      p = Promise.race([Promise.resolve().then(() => source.search(brief, { limit, signal: controller.signal })), timeout])
        .then((found): Fetched => {
          const profiles = found.slice(0, limit);
          for (const k of keys) safe(() => store.putProfiles(source.name, k, profiles));
          return { ok: true, profiles };
        })
        .catch((err): Fetched => ({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        .finally(() => {
          clearTimeout(timer);
          inflight.delete(id);
        });
      inflight.set(id, p);
    }
    if (onLate) void p.then(onLate);
    return p;
  }

  async function searchOne(
    source: FreelancerSource,
    brief: Brief,
    keys: string[],
    limit: number,
    deadline: Promise<'deadline'>,
    progress: (m: string) => void,
    done: (s: SourceStatus) => void,
  ): Promise<{ profiles: FreelancerProfile[]; status: SourceStatus }> {
    const started = Date.now();
    const finish = (profiles: FreelancerProfile[], p: Omit<SourceStatus, 'source' | 'ms' | 'count'>) => {
      const status: SourceStatus = { source: source.name, ms: Date.now() - started, count: profiles.length, ...p };
      done(status);
      return { profiles, status };
    };
    const background = (r: Fetched) => progress(r.ok ? `${source.name}: ${r.profiles.length} profiles (late, ready for the next search)` : `${source.name}: background refresh failed`);

    const ttl = config.DEMO_MODE ? Number.MAX_SAFE_INTEGER : config.PROFILE_CACHE_TTL_MIN * 60_000;
    const fresh = cacheGet(source.name, keys.slice(0, 1), ttl);
    if (fresh) {
      progress(`${source.name}: ${fresh.length} profiles (cached)`);
      return finish(fresh, { ok: true, cached: true });
    }
    // Rephrased brief or expired entry: serve it now, refresh behind (except in a pinned demo).
    const stale = cacheGet(source.name, keys, Number.MAX_SAFE_INTEGER);
    if (stale) {
      const pinned = config.DEMO_MODE;
      if (!pinned) fetchLive(source, brief, keys, limit, background);
      progress(`${source.name}: ${stale.length} profiles (cached${pinned ? '' : ', refreshing'})`);
      // Expired, or found under the looser key (another wording of the brief): not this brief's fresh answer.
      return finish(stale, { ok: true, cached: true, ...(!pinned && { stale: true }) });
    }

    if (source.kind === 'browser') {
      // Never wait on a browser: read in the background for next time.
      fetchLive(source, brief, keys, limit, background);
      progress(`${source.name}: reading in the background`);
      return finish([], { ok: false, cached: false, late: true, error: 'reading in the background' });
    }

    progress(`Searching ${source.name}…`);
    const live = fetchLive(source, brief, keys, limit);
    const r = await Promise.race([live, deadline]);
    if (r === 'deadline') {
      void live.then(background);
      progress(`${source.name}: still searching, ranking without it`);
      return finish([], { ok: false, cached: false, late: true, error: `no answer within the ${Date.now() - started} ms budget` });
    }
    if (r.ok) {
      progress(`${source.name}: ${r.profiles.length} profiles`);
      return finish(r.profiles, { ok: true, cached: false });
    }
    progress(`${source.name}: unavailable`);
    return finish([], { ok: false, cached: false, error: r.error });
  }

  return {
    all: () => [...sources],
    enabled,
    get: (name) => sources.find((s) => s.name === name),
    async settle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight.values()]);
    },
    async searchAll(brief, opts) {
      const loose = skillsKey(brief);
      const keys = loose ? [queryKey(brief), loose] : [queryKey(brief)];
      const budget = Math.max(0, Math.min(opts.budgetMs ?? config.SEARCH_BUDGET_MS, config.DEMO_MODE ? config.DEMO_BUDGET_MS : Number.MAX_SAFE_INTEGER));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<'deadline'>((resolve) => {
        timer = setTimeout(() => resolve('deadline'), budget);
      });
      const progress = (message: string): void => {
        if (opts.jobId) bus.emit({ type: 'job.progress', jobId: opts.jobId, message });
      };
      const done = (status: SourceStatus): void => bus.emit({ type: 'source.done', ...(opts.jobId && { jobId: opts.jobId }), status });
      try {
        const results = await Promise.all(enabled().map((s) => searchOne(s, brief, keys, opts.limitPerSource, deadline, progress, done)));
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
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
