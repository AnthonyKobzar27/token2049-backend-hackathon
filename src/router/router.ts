// Fan out, drop rejected profiles, score fit, rank and explain.

import type { Config } from '../config';
import type { EventBus, Router, SourceRegistry, SuitabilityScorer } from '../domain/ports';
import { rank } from './match';

export function createRouter(deps: { registry: SourceRegistry; suitability: SuitabilityScorer; bus: EventBus; config: Config }): Router {
  const { registry, suitability, bus } = deps;
  return {
    async route(brief, opts) {
      const { profiles, sources } = await registry.searchAll(brief, { limitPerSource: 25, jobId: opts.jobId });
      const excluded = new Set(opts.exclude ?? []);
      const pool = profiles.filter((p) => !excluded.has(p.id));
      if (opts.jobId) bus.emit({ type: 'job.progress', jobId: opts.jobId, message: `Scoring ${pool.length} profiles…` });
      const scoringBrief = opts.feedback ? { ...brief, notes: [brief.notes, opts.feedback].filter(Boolean).join('\n') } : brief;
      const scores = await suitability.score(scoringBrief, pool);
      const candidates = rank(brief, pool, scores, { limit: opts.limit, exclude: opts.exclude });
      return { candidates, sources };
    },
  };
}
