// Scoring weights per kind of task. An errand in Singapore on Saturday cares about distance and
// the day; a remote logo cares about fit and price. Weights are renormalised over the dimensions
// that apply, so they need not sum to 1.

import type { Brief, Subscores, TaskType } from '../domain/types';

export type Weights = Record<keyof Subscores, number>;

export const TASK_WEIGHTS: Record<TaskType, Weights> = {
  in_person: { suitability: 0.3, price: 0.1, rating: 0.1, availability: 0.1, speed: 0, location: 0.25, timing: 0.15 },
  remote_creative: { suitability: 0.45, price: 0.25, rating: 0.15, availability: 0.05, speed: 0.1, location: 0.03, timing: 0.05 },
  remote_technical: { suitability: 0.45, price: 0.2, rating: 0.15, availability: 0.1, speed: 0.1, location: 0.03, timing: 0.05 },
  remote_general: { suitability: 0.45, price: 0.2, rating: 0.15, availability: 0.1, speed: 0.1, location: 0.05, timing: 0.1 },
};
export const DEFAULT_WEIGHTS = TASK_WEIGHTS.remote_general;

const CREATIVE = /\b(design|logo|brand|illustrat|graphic|video|edit|animat|photo|copywrit|writ|blog|content|voice|music|audio|podcast|ui\b|ux\b|figma|art|subtitl|translat)/;
const TECHNICAL = /\b(develop|program|code|coding|react|python|javascript|typescript|api|app\b|apps\b|software|website|web\b|smart contract|solidity|rust|devops|engineer|scrap|automation|database|data (engineer|pipeline|science)|machine learning|backend|frontend)/;

/** The brief's own taskType, else on-site briefs are in_person and remote ones are sorted by keywords. */
export function inferTaskType(brief: Brief): TaskType {
  if (brief.taskType && brief.taskType in TASK_WEIGHTS) return brief.taskType;
  if (brief.remoteOk === false) return 'in_person';
  const text = `${brief.task} ${brief.skills.join(' ')}`.toLowerCase();
  if (TECHNICAL.test(text)) return 'remote_technical';
  if (CREATIVE.test(text)) return 'remote_creative';
  return 'remote_general';
}

/**
 * Weights for a brief. `override` is JSON from config.ROUTER_WEIGHTS, e.g.
 * {"in_person":{"location":0.4}}; unknown keys and bad JSON are ignored.
 */
export function weightsFor(brief: Brief, override?: string): { taskType: TaskType; weights: Weights } {
  const taskType = inferTaskType(brief);
  const weights = { ...TASK_WEIGHTS[taskType] };
  if (override) {
    try {
      const parsed = JSON.parse(override) as Record<string, Partial<Record<string, unknown>>>;
      for (const [k, v] of Object.entries(parsed[taskType] ?? {})) {
        if (k in weights && typeof v === 'number' && Number.isFinite(v) && v >= 0) weights[k as keyof Weights] = v;
      }
    } catch {
      // a broken override must not break routing
    }
  }
  return { taskType, weights };
}
