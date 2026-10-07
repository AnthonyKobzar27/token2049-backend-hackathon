// Checks a worker's submission before it reaches the client and before anyone is paid.
// Rules always run; the model adds a plausibility read when a key is set. A failed check
// goes back to the worker with the issues as feedback.

import { z } from 'zod';
import { structuredCall } from '../agent/intake';
import type { Config } from '../config';
import { hasLlm } from '../llm/client';
import type { Bounty, QaVerdict } from './types';

export type { QaVerdict };

const DAY = 86_400_000;
const CANNOT = /\b(could ?n[o']t|can ?n[o']t|unable|no answer|did ?n[o']t (pick up|answer)|closed|fully booked|no slots?)\b/i;

/** Deterministic checks on a submitted bounty. */
export function rulesQa(b: Bounty): QaVerdict {
  const r = b.result;
  const at = r?.submittedAt ?? Date.now();
  if (!r) return { ok: false, issues: ['Nothing was submitted.'], by: 'rules', at };
  const issues: string[] = [];
  const task = `${b.task} ${b.spec.instructions}`.toLowerCase();

  for (const f of b.spec.fields) {
    const v = r.data[f.key];
    if (f.required && !v) issues.push(`${f.label} is missing.`);
    if (!v) continue;
    if (f.type === 'date') {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (m) {
        const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        const today = Math.floor(at / DAY) * DAY;
        if (day < today) issues.push(`${f.label} ${v} is in the past.`);
        else if (/\bthis week\b/.test(task) && day > today + 7 * DAY) issues.push(`${f.label} ${v} is not this week.`);
        else if (/\b(today)\b/.test(task) && day !== today) issues.push(`${f.label} ${v} is not today.`);
      }
    }
    if (f.type === 'time') {
      const m = /^(\d{1,2}):(\d{2})$/.exec(v);
      if (m && (Number(m[1]) > 23 || Number(m[2]) > 59)) issues.push(`${f.label} ${v} is not a valid time.`);
    }
    if (/reference|ref|confirmation|booking_?(no|number|id)/i.test(f.key) && !/[a-z0-9]{2,}/i.test(v)) issues.push(`${f.label} "${v}" does not look like a reference.`);
  }
  if (r.notes && CANNOT.test(r.notes) && b.spec.fields.some((f) => f.type === 'date' || /reference/.test(f.key))) {
    issues.push('Your notes say it could not be done, but a booking was submitted. Please confirm the booking or explain.');
  }
  return { ok: issues.length === 0, issues, by: 'rules', at };
}

const LlmOut = z.object({ ok: z.boolean(), issues: z.array(z.string().max(200)).max(5) });
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'issues'],
  properties: { ok: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } },
};
const SYSTEM = `You check a result a person submitted for a small real-world task before the client sees it.
Say ok=false only when the result plainly does not answer the task, contradicts itself, or contradicts the notes.
Do not ask for things the task did not ask for. Issues are short lines addressed to the worker.`;

/** Rules first; the model can only add issues, never clear a rules failure. Never throws. */
export async function checkSubmission(b: Bounty, config: Config): Promise<QaVerdict> {
  const rules = rulesQa(b);
  if (!rules.ok || !hasLlm(config) || !b.result) return rules;
  try {
    const out = await structuredCall(
      config,
      {
        system: SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify({ task: b.task, fields: b.spec.fields.map((f) => f.label), result: b.result.data, summary: b.result.summary, notes: b.result.notes }) }],
        schema: SCHEMA,
        maxTokens: 400,
      },
      (raw) => LlmOut.parse(raw),
    );
    return { ok: out.ok, issues: out.ok ? [] : out.issues.length ? out.issues : ['The result does not seem to answer the task.'], by: 'llm', at: rules.at };
  } catch (err) {
    console.error('[bounty] model check failed, using rules:', err instanceof Error ? err.message : err);
    return rules;
  }
}
