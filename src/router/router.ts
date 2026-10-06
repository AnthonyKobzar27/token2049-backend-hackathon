// Fan out, drop rejected profiles, score fit, rank and explain, all within one time budget:
// the search gets most of it, suitability scoring whatever is left (never less than a floor,
// since the heuristic answers at once anyway).

import type { Config } from '../config';
import type { EventBus, Router, SourceRegistry, SuitabilityScorer } from '../domain/ports';
import { rank } from './match';
import { weightsFor } from './weights';

/** Share of the whole budget the source search may use. */
const SEARCH_SHARE = 0.65;
/** Scoring always gets at least this long (the heuristic fills in whatever the model misses). */
const MIN_SCORING_MS = 100;

/** The budget for one routing request: the demo budget when pinned, else SEARCH_BUDGET_MS. */
export function routeBudgetMs(config: Config): number {
  return config.DEMO_MODE ? Math.min(config.DEMO_BUDGET_MS, config.SEARCH_BUDGET_MS) : config.SEARCH_BUDGET_MS;
}

export function createRouter(deps: { registry: SourceRegistry; suitability: SuitabilityScorer; bus: EventBus; config: Config }): Router {
  const { registry, suitability, bus, config } = deps;
  return {
    async route(brief, opts) {
      const started = Date.now();
      const total = routeBudgetMs(config);
      const progress = (message: string): void => {
        if (opts.jobId) bus.emit({ type: 'job.progress', jobId: opts.jobId, message });
      };

      const { profiles, sources } = await registry.searchAll(brief, { limitPerSource: 25, jobId: opts.jobId, budgetMs: Math.round(total * SEARCH_SHARE) });
      const excluded = new Set(opts.exclude ?? []);
      const pool = profiles.filter((p) => !excluded.has(p.id));
      const late = sources.filter((s) => s.late).map((s) => s.source);
      if (late.length > 0) progress(`Ranking without ${late.join(', ')} (still searching)`);
      progress(`Scoring ${pool.length} profiles…`);

      const scoringBrief = opts.feedback ? { ...brief, notes: [brief.notes, opts.feedback].filter(Boolean).join('\n') } : brief;
      const budgetMs = Math.max(MIN_SCORING_MS, total - (Date.now() - started));
      const scores = await suitability.score(scoringBrief, pool, { budgetMs });

      const { weights } = weightsFor(brief, config.ROUTER_WEIGHTS);
      const candidates = rank(brief, pool, scores, { limit: opts.limit, exclude: opts.exclude, weights });
      return { candidates, sources };
    },
  };
}
