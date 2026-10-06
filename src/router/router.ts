// Fan out, drop rejected profiles, score fit, rank and explain.

import type { Config } from '../config';
import type { EventBus, Router, SourceRegistry, SuitabilityScorer } from '../domain/ports';
import { rank, type OnChainSignal } from './match';

/** Cache-only reader of on-chain identity (src/identity registry). Must return at once. */
export interface OnChainSignals {
  signals(profileIds: string[]): Map<string, OnChainSignal>;
}

export function createRouter(deps: { registry: SourceRegistry; suitability: SuitabilityScorer; bus: EventBus; config: Config; identity?: OnChainSignals }): Router {
  const { registry, suitability, bus } = deps;
  return {
    async route(brief, opts) {
      const { profiles, sources } = await registry.searchAll(brief, { limitPerSource: 25, jobId: opts.jobId });
      const excluded = new Set(opts.exclude ?? []);
      const pool = profiles.filter((p) => !excluded.has(p.id));
      if (opts.jobId) bus.emit({ type: 'job.progress', jobId: opts.jobId, message: `Scoring ${pool.length} profiles…` });
      const scoringBrief = opts.feedback ? { ...brief, notes: [brief.notes, opts.feedback].filter(Boolean).join('\n') } : brief;
      const scores = await suitability.score(scoringBrief, pool);
      const onchain = readSignals(deps.identity, pool.map((p) => p.id));
      const candidates = rank(brief, pool, scores, { limit: opts.limit, exclude: opts.exclude, ...(onchain ? { onchain } : {}) });
      return { candidates, sources };
    },
  };
}

/** Identity is a bonus: any failure here ranks without it. */
function readSignals(identity: OnChainSignals | undefined, ids: string[]): Map<string, OnChainSignal> | undefined {
  if (!identity) return undefined;
  try {
    return identity.signals(ids);
  } catch (err) {
    console.error('[router] on-chain identity lookup failed:', err);
    return undefined;
  }
}
