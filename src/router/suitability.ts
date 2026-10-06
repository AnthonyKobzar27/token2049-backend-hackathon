// How well does each freelancer fit the job? LLM-scored in batches, cached per (brief, profile),
// with a deterministic keyword heuristic as the fallback. Never throws.

import { createHash } from 'node:crypto';
import type { Config } from '../config';
import type { Store, SuitabilityScorer } from '../domain/ports';
import type { Brief, FreelancerProfile, SuitabilityScore } from '../domain/types';
import { anthropic, hasLlm } from '../llm/client';

const BATCH_SIZE = 10;
const CONCURRENCY = 3;
const LLM_CAP = 40;

/** Scores one batch; returns a map by profile id. May throw: the caller falls back to the heuristic. */
export type BatchScorer = (brief: Brief, batch: FreelancerProfile[]) => Promise<Map<string, SuitabilityScore>>;

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function briefKey(brief: Brief): string {
  const skills = brief.skills.map(norm).sort();
  return createHash('sha256').update(JSON.stringify([norm(brief.task), skills, norm(brief.notes ?? '')])).digest('hex').slice(0, 32);
}

// -------------------------------------------------------------- heuristic

const STOP = new Set(['the', 'and', 'for', 'with', 'need', 'needs', 'want', 'who', 'that', 'this', 'can', 'will', 'has', 'have', 'from', 'into', 'about', 'some', 'our', 'your', 'you', 'are', 'any', 'per', 'job', 'work', 'someone', 'looking', 'hire']);
const tokens = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}+#]+/u)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    out.add(raw.length > 4 && raw.endsWith('s') ? raw.slice(0, -1) : raw);
  }
  return out;
};

/** Keyword overlap between the brief and the profile's skills, headline and category, as 0-1. */
export function keywordScore(brief: Brief, profile: FreelancerProfile): number {
  const want = tokens(`${brief.task} ${brief.skills.join(' ')}`);
  if (want.size === 0) return 0;
  const have = tokens(`${profile.skills.join(' ')} ${profile.headline} ${profile.category ?? ''}`);
  let hit = 0;
  for (const w of want) if (have.has(w)) hit++;
  return Math.min(1, (hit / want.size) * 2.5);
}

export const heuristicScore = (brief: Brief, profile: FreelancerProfile): SuitabilityScore => ({
  score: Math.round(keywordScore(brief, profile) * 100) / 100,
  reason: 'keyword match',
});

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
    async score(brief, profiles) {
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

      const heuristic = new Map(todo.map((p) => [p.id, heuristicScore(brief, p)] as const));
      let forLlm: FreelancerProfile[] = [];
      if (llm) forLlm = todo.length > LLM_CAP ? [...todo].sort((a, b) => heuristic.get(b.id)!.score - heuristic.get(a.id)!.score).slice(0, LLM_CAP) : todo;

      const batches: FreelancerProfile[][] = [];
      for (let i = 0; i < forLlm.length; i += BATCH_SIZE) batches.push(forLlm.slice(i, i + BATCH_SIZE));
      const scored = new Map<string, SuitabilityScore>();
      if (llm) {
        await pool(batches, CONCURRENCY, async (batch) => {
          try {
            for (const [id, s] of await llm(brief, batch)) scored.set(id, s);
          } catch (err) {
            console.error('[suitability] batch failed, using keyword heuristic:', err instanceof Error ? err.message : err);
          }
        });
      }
      for (const [id, s] of scored) {
        result.set(id, s);
        try {
          store.putSuitability(key, id, s);
        } catch {
          // cache write is best effort
        }
      }
      // Everything the model did not score gets the heuristic (not cached, so a later run can do better).
      for (const p of todo) if (!result.has(p.id)) result.set(p.id, heuristic.get(p.id)!);
      return result;
    },
  };
}
