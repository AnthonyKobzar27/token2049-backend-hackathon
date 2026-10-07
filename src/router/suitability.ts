// How well does each freelancer fit the job? LLM-scored in batches, cached per (brief, profile),
// with a deterministic TF-IDF heuristic (relevance.ts) as the fallback. Never throws.
// With a time budget, batches still out when it ends keep the heuristic for this round
// and are cached when they land, so the next round has them.

import { createHash } from 'node:crypto';
import type { Config } from '../config';
import type { Store, SuitabilityScorer } from '../domain/ports';
import type { Brief, FreelancerProfile, SuitabilityScore } from '../domain/types';
import { anthropic, hasLlm } from '../llm/client';
import { relevanceScores } from './relevance';

const BATCH_SIZE = 10;
/** All batches of the capped set run at once: LLM_CAP / BATCH_SIZE. */
const CONCURRENCY = 4;
const LLM_CAP = 40;

/** Scores one batch; returns a map by profile id. May throw: the caller falls back to the heuristic. */
export type BatchScorer = (brief: Brief, batch: FreelancerProfile[]) => Promise<Map<string, SuitabilityScore>>;

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function briefKey(brief: Brief): string {
  const skills = brief.skills.map(norm).sort();
  return createHash('sha256').update(JSON.stringify([norm(brief.task), skills, norm(brief.notes ?? '')])).digest('hex').slice(0, 32);
}

// -------------------------------------------------------------- heuristic

/** One profile scored on its own (IDF over a set of one). The scorer itself uses the whole set. */
export const heuristicScore = (brief: Brief, profile: FreelancerProfile): SuitabilityScore => relevanceScores(brief, [profile]).get(profile.id)!;

// -------------------------------------------------------------------- llm

const TOOL_NAME = 'record_scores';
// Some newer models reject forced tool_choice; they get 'auto' plus an instruction instead.
const rejectsForcedTool = (model: string): boolean => /fable|mythos|opus-5-5|sonnet-5-5/.test(model);

const SYSTEM = `You judge how well freelancers fit a specific job for a hiring router. Score each candidate from 0 to 1 on suitability for THIS job only (ignore price and ratings, which are scored elsewhere).
0.9-1: clearly specialised in exactly this work. 0.6-0.8: relevant and capable. 0.3-0.5: adjacent skills. 0-0.2: different field or contradicts the brief (wrong language, wrong kind of work).
Missing information is not a reason to score low; judge on what is published. Give a reason of at most 15 words that names what fits or does not. Call ${TOOL_NAME} with one entry per candidate, using its number as id.`;

const trim = (s: string | undefined, n: number): string | undefined => (s && s.length > n ? `${s.slice(0, n)}…` : s);

function renderPrompt(brief: Brief, batch: FreelancerProfile[]): string {
  const job = { task: brief.task, skills: brief.skills, notes: brief.notes, location: brief.location, remoteOk: brief.remoteOk, language: brief.language, hoursNeeded: brief.hoursNeeded, deadlineDays: brief.deadlineDays };
  const people = batch.map((p, i) => ({
    id: String(i + 1),
    headline: p.headline,
    skills: p.skills.slice(0, 15),
    category: p.category,
    description: trim(p.description, 300),
    country: p.country,
    city: p.city,
    languages: p.languages,
    level: p.level,
  }));
  return `Job:\n${JSON.stringify(job)}\n\nCandidates:\n${JSON.stringify(people)}`;
}

export function createLlmBatchScorer(config: Config): BatchScorer {
  return async (brief, batch) => {
    const client = anthropic(config);
    const forced = !rejectsForcedTool(config.MODEL_FAST);
    const res = await client.messages.create({
      model: config.MODEL_FAST,
      max_tokens: 2048,
      system: SYSTEM,
      messages: [{ role: 'user', content: renderPrompt(brief, batch) }],
      tools: [
        {
          name: TOOL_NAME,
          description: 'Record a suitability score for every candidate.',
          input_schema: {
            type: 'object',
            properties: {
              scores: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Candidate number as given' },
                    score: { type: 'number', description: '0 to 1' },
                    reason: { type: 'string', description: 'At most 15 words' },
                  },
                  required: ['id', 'score', 'reason'],
                },
              },
            },
            required: ['scores'],
          },
        },
      ],
      tool_choice: forced ? { type: 'tool', name: TOOL_NAME } : { type: 'auto' },
    });
    const out = new Map<string, SuitabilityScore>();
    for (const block of res.content) {
      if (block.type !== 'tool_use' || block.name !== TOOL_NAME) continue;
      const scores = (block.input as { scores?: unknown })?.scores;
      if (!Array.isArray(scores)) continue;
      for (const item of scores) {
        const it = item as { id?: unknown; score?: unknown; reason?: unknown };
        const profile = batch[Number(it.id) - 1];
        const score = Number(it.score);
        if (!profile || !Number.isFinite(score)) continue;
        out.set(profile.id, { score: Math.min(1, Math.max(0, score)), reason: clipWords(typeof it.reason === 'string' ? it.reason : '', 15) || 'scored by model' });
      }
    }
    return out;
  };
}

export function clipWords(text: string, max: number): string {
  const words = text.trim().replace(/[.\s]+$/, '').split(/\s+/).filter(Boolean);
  return words.slice(0, max).join(' ');
}

// ----------------------------------------------------------------- scorer

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/** `score` is injectable for tests; when absent the Anthropic API is used if a key is configured. */
export function createSuitabilityScorer(deps: { store: Store; config: Config }, score?: BatchScorer): SuitabilityScorer {
  const { store, config } = deps;
  const llm: BatchScorer | undefined = score ?? (hasLlm(config) ? createLlmBatchScorer(config) : undefined);

  return {
    async score(brief, profiles, opts) {
      const result = new Map<string, SuitabilityScore>();
      const key = briefKey(brief);
      const todo: FreelancerProfile[] = [];
      for (const p of profiles) {
        let cached: SuitabilityScore | null = null;
        try {
          cached = store.getSuitability(key, p.id);
        } catch {
          // a broken cache must not break scoring
        }
        if (cached) result.set(p.id, cached);
        else todo.push(p);
      }
      if (todo.length === 0) return result;

      const heuristic = relevanceScores(brief, todo);
      let forLlm: FreelancerProfile[] = [];
      if (llm) forLlm = todo.length > LLM_CAP ? [...todo].sort((a, b) => heuristic.get(b.id)!.score - heuristic.get(a.id)!.score).slice(0, LLM_CAP) : todo;

      const batches: FreelancerProfile[][] = [];
      for (let i = 0; i < forLlm.length; i += BATCH_SIZE) batches.push(forLlm.slice(i, i + BATCH_SIZE));
      const scored = new Map<string, SuitabilityScore>();
      const save = (id: string, s: SuitabilityScore): void => {
        try {
          store.putSuitability(key, id, s);
        } catch {
          // cache write is best effort
        }
      };
      let open = true;
      if (llm && batches.length > 0) {
        const work = pool(batches, CONCURRENCY, async (batch) => {
          try {
            for (const [id, s] of await llm(brief, batch)) {
              save(id, s);
              if (open) scored.set(id, s);
            }
          } catch (err) {
            console.error('[suitability] batch failed, using keyword heuristic:', err instanceof Error ? err.message : err);
          }
        });
        const budget = opts?.budgetMs;
        if (budget !== undefined && Number.isFinite(budget)) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([work, new Promise<void>((r) => { timer = setTimeout(r, Math.max(0, budget)); })]);
          clearTimeout(timer);
        } else await work;
        open = false;
      }
      for (const [id, s] of scored) result.set(id, s);
      // Everything the model did not score gets the heuristic (not cached, so a later run can do better).
      for (const p of todo) if (!result.has(p.id)) result.set(p.id, heuristic.get(p.id) ?? { score: 0, reason: 'little overlap with the brief' });
      return result;
    },
  };
}
