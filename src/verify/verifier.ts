// ResultVerifier: the QA step between "delivered" and "escrow released".
// Deterministic checks first (cheap, explainable), then an LLM rubric, all inside one time box.
// Never throws: anything that goes wrong becomes verdict 'needs_human'.
import type { Config } from '../config';
import type { Brief, DeliveredResult, VerificationCheck, VerificationReport, VerificationVerdict } from '../domain/types';
import { hasLlm } from '../llm/client';
import { type RuleCheck, ruleChecks, urlChecks } from './checks';
import { deliveryHash, isEmptyDelivery, verifiedResultHash } from './hash';
import { createLlmRubric, type RubricJudge } from './rubric';

export interface VerifyInput {
  bookingId: string;
  brief: Brief;
  delivery: DeliveredResult;
  /** Picks the stronger model at or above config.VERIFY_STRONG_MIN_USD. */
  priceUsd: number;
  /** 1 for the first QA run on this booking. */
  attempt?: number;
  /** Masumi identifierFromPurchaser, when the job came through Masumi. Defaults to the booking id. */
  identifier?: string;
}

export interface ResultVerifier {
  verify(input: VerifyInput): Promise<VerificationReport>;
}

export interface VerifierDeps {
  config: Config;
  /** Injectable for tests. Undefined: Claude when ANTHROPIC_API_KEY is set. Null: no rubric. */
  rubric?: RubricJudge | null;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Below this the rubric is not even started. */
const MIN_RUBRIC_MS = 500;
const PASS_FLOOR = 0.6;

class TimeoutError extends Error {
  override name = 'TimeoutError';
}

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`no answer within ${ms} ms`)); // settle the race first, then cancel the request
      ac.abort();
    }, ms);
  });
  return Promise.race([run(ac.signal), timeout]).finally(() => clearTimeout(timer));
}

const strip = (c: RuleCheck | VerificationCheck): VerificationCheck => ({ name: c.name, ok: c.ok, detail: c.detail, ...(c.by ? { by: c.by } : {}) });
const round2 = (n: number) => Math.round(n * 100) / 100;

export function pickModel(config: Config, priceUsd: number): string {
  return priceUsd >= config.VERIFY_STRONG_MIN_USD ? config.MODEL_VERIFY_STRONG : config.MODEL_VERIFY;
}

export function createResultVerifier(deps: VerifierDeps): ResultVerifier {
  const { config } = deps;
  const now = deps.now ?? Date.now;
  const rubric: RubricJudge | null = deps.rubric === undefined ? (hasLlm(config) ? createLlmRubric(config) : null) : deps.rubric;

  return {
    async verify(input) {
      const t0 = now();
      const deadline = t0 + config.VERIFY_TIMEOUT_MS;
      const base = {
        resultHash: verifiedResultHash(input.bookingId, input.delivery, input.identifier),
        deliveryHash: deliveryHash(input.delivery),
        attempt: input.attempt ?? 1,
      };
      const report = (verdict: VerificationVerdict, score: number, checks: VerificationCheck[], summary: string, model?: string): VerificationReport => ({
        verdict,
        score: round2(Math.min(1, Math.max(0, score))),
        checks: checks.map(strip),
        summary,
        ...base,
        ...(model ? { model } : {}),
        ms: now() - t0,
        at: now(),
      });

      let checks: RuleCheck[] = [];
      try {
        if (isEmptyDelivery(input.delivery)) {
          // Many platforms do not expose the delivered files to the API: nothing to judge is not proof of bad work.
          return report('needs_human', 0, [{ name: 'non_empty', ok: false, detail: 'no delivery content could be read from the platform', by: 'rule' }],
            'No delivery content could be read from the platform. A person must check the work there before the budget is released.');
        }

        checks = ruleChecks(input.brief, input.delivery);
        const urlBudget = Math.max(0, Math.min(config.VERIFY_URL_TIMEOUT_MS, deadline - now() - MIN_RUBRIC_MS));
        if (input.delivery.urls?.length && urlBudget > 0) checks.push(...(await urlChecks(input.delivery.urls, { timeoutMs: urlBudget, fetch: deps.fetch })));

        const ruleScore = checks.length ? checks.filter((c) => c.ok).length / checks.length : 0;
        const hardFails = checks.filter((c) => !c.ok && c.hard);
        if (hardFails.length) {
          return report('fail', ruleScore * 0.5, checks, `Automatic checks failed: ${hardFails.map((c) => c.detail).join('; ')}.`);
        }

        const passed = `${checks.filter((c) => c.ok).length}/${checks.length} automatic checks passed`;
        if (!rubric) {
          return report('needs_human', ruleScore * 0.5, [...checks, { name: 'quality_review', ok: false, detail: 'language model not configured', by: 'rule' }],
            `${passed}; the quality review is unavailable, so a person must confirm the work.`);
        }

        const remaining = deadline - now();
        const model = pickModel(config, input.priceUsd);
        if (remaining < MIN_RUBRIC_MS) {
          return report('needs_human', ruleScore * 0.5, [...checks, { name: 'quality_review', ok: false, detail: 'no time left for the quality review', by: 'rule' }],
            `${passed}; the quality review ran out of time, so a person must confirm the work.`, model);
        }

        let r;
        try {
          r = await withTimeout((signal) => rubric({ brief: input.brief, delivery: input.delivery, ruleChecks: checks.map(strip), model, signal, timeoutMs: remaining }), remaining);
        } catch (err) {
          const why = err instanceof TimeoutError ? `timed out after ${remaining} ms` : `unavailable: ${(err as Error)?.message ?? String(err)}`;
          return report('needs_human', ruleScore * 0.5, [...checks, { name: 'quality_review', ok: false, detail: why, by: 'llm' }],
            `${passed}; the quality review ${err instanceof TimeoutError ? 'timed out' : 'failed'}, so a person must confirm the work.`, model);
        }

        const score = 0.3 * ruleScore + 0.7 * r.score;
        let verdict = r.verdict;
        // Guard against a self-contradicting review: a pass needs a decent score and no failed criterion,
        // a fail needs at least one failed criterion. Otherwise a person decides.
        if (verdict === 'pass' && (r.score < PASS_FLOOR || r.checks.some((c) => !c.ok))) verdict = 'needs_human';
        if (verdict === 'fail' && r.checks.length && r.checks.every((c) => c.ok)) verdict = 'needs_human';
        return report(verdict, score, [...checks, ...r.checks.map((c) => ({ ...c, by: c.by ?? ('llm' as const) }))], r.summary, model);
      } catch (err) {
        console.error(`[verify] ${input.bookingId} failed:`, err);
        return report('needs_human', 0, [...checks, { name: 'verifier', ok: false, detail: `error: ${(err as Error)?.message ?? String(err)}`, by: 'rule' }],
          'The quality check hit an error, so a person must confirm the work.');
      }
    },
  };
}
