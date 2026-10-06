// Turns a brief into a bounty spec: a short title, instructions, and the result fields the
// worker must fill in. The model drafts it when a key is set; rules are the fallback.

import { z } from 'zod';
import { structuredCall } from '../agent/intake';
import type { Config } from '../config';
import type { Brief } from '../domain/types';
import { hasLlm } from '../llm/client';
import { toUsd } from '../router/fx';
import { findPlace } from './places';
import type { BountySpec, ResultField } from './types';

const KIND_LABEL: Record<BountySpec['kind'], string> = {
  phone_call: 'Phone call',
  on_site: 'On site',
  errand: 'Errand',
  online: 'Online',
  other: 'Task',
};
const KIND_MINUTES: Record<BountySpec['kind'], number> = { phone_call: 5, on_site: 30, errand: 45, online: 10, other: 15 };

const f = (key: string, label: string, type: ResultField['type'], required: boolean, hint?: string): ResultField => ({ key, label, type, required, ...(hint && { hint }) });

function kindOf(text: string, brief: Brief): BountySpec['kind'] {
  if (/\b(call|phone|ring|telephone)\b/.test(text)) return 'phone_call';
  if (/\b(pick ?up|drop ?off|deliver|courier|buy|collect)\b/.test(text)) return 'errand';
  if (/\b(visit|go to|queue|on.?site|in person|photo of|photograph|walk to|stand in line)\b/.test(text) || brief.remoteOk === false) return 'on_site';
  if (/\b(online|website|email|web form|search)\b/.test(text)) return 'online';
  return 'other';
}

function shortTask(task: string): string {
  const t = task.toLowerCase();
  const book = /\b(?:book|reserve|schedule)\s+(?:me\s+)?(?:the\s+|a\s+|an\s+)?(?:earliest\s+|next\s+|first\s+|soonest\s+)?(?:available\s+)?([a-z][a-z -]{1,30}?)\s+(slot|appointment|table|session|class)\b/.exec(t);
  if (book) return `book a ${book[1]!.trim()} ${book[2]}`;
  const clause = t.split(/[.;\n]/)[0]!.replace(/^(please\s+)?(can you\s+)?/, '').trim();
  return clause.length > 48 ? `${clause.slice(0, 45).trimEnd()}…` : clause;
}

/** Reward in local currency (SGD in Singapore), from the time it takes, capped by the budget. */
export function rewardFor(brief: Brief, estMinutes: number): { amount: number; currency: string; usd: number } {
  const sg = /singapore|\bsg\b/i.test(`${brief.location ?? ''} ${brief.task}`) || (findPlace(`${brief.task} ${brief.location ?? ''}`)?.point.lng ?? 0) > 103;
  const currency = sg ? 'SGD' : 'USD';
  let amount = Math.max(3, Math.ceil(estMinutes * 0.6));
  const rate = toUsd(1, currency) ?? 1;
  if (brief.budgetUsd !== undefined && brief.budgetUsd > 0) amount = Math.min(amount, Math.max(1, Math.floor(brief.budgetUsd / rate)));
  return { amount, currency, usd: Math.round(amount * rate * 100) / 100 };
}

export const rewardLabel = (r: { amount: number; currency: string }): string => (r.currency === 'SGD' ? `S$${r.amount}` : r.currency === 'USD' ? `$${r.amount}` : `${r.amount} ${r.currency}`);

export function titleFor(kind: BountySpec['kind'], estMinutes: number, task: string, reward: { amount: number; currency: string }): string {
  return `${KIND_LABEL[kind]}, ~${estMinutes} min, ${task}, ${rewardLabel(reward)}`;
}

/** Deterministic spec. */
export function rulesSpec(brief: Brief): BountySpec {
  const text = `${brief.task} ${brief.notes ?? ''}`.toLowerCase();
  const kind = kindOf(text, brief);
  const estMinutes = brief.hoursNeeded ? Math.max(5, Math.round(brief.hoursNeeded * 60)) : KIND_MINUTES[kind];
  const found = findPlace(`${brief.task} ${brief.location ?? ''}`);
  const placeName = /\b(?:call|visit|go to|ring|phone)\s+(?:the\s+)?([A-Z][\w'&-]*(?:\s+[A-Z][\w'&-]*){0,5})/.exec(brief.task)?.[1];

  let fields: ResultField[];
  let summaryTemplate: string;
  if (/\b(book|reserve|schedule|appointment|slot|reservation)\b/.test(text)) {
    fields = [
      f('date', 'Date', 'date', true, 'Day of the booking'),
      f('time', 'Time', 'time', true, 'Start time, 24h'),
      f('reference', 'Reference number', 'text', true, 'Booking or confirmation number'),
    ];
    summaryTemplate = 'Booked: {date} {time}, ref {reference}';
  } else if (/\b(photo|picture|snap|photograph)\b/.test(text)) {
    fields = [f('photo_url', 'Photo link', 'url', true, 'Link to the photo'), f('observation', 'What you saw', 'text', true)];
    summaryTemplate = '{observation} (photo: {photo_url})';
  } else if (/\b(ask|check|find out|confirm|whether|price|cost|availab|open|hours|wait time)\b/.test(text)) {
    fields = [f('answer', 'Answer', 'text', true, 'What you found out, in one line'), f('source', 'Who told you', 'text', false, 'Name or role of the person')];
    summaryTemplate = '{answer}';
  } else {
    fields = [f('outcome', 'Outcome', 'text', true, 'What was done, in one line')];
    summaryTemplate = '{outcome}';
  }

  const reward = rewardFor(brief, estMinutes);
  const where = placeName ?? found?.name;
  const steps = [
    brief.task.trim().replace(/\.?$/, '.'),
    brief.notes ? `Details from the client: ${brief.notes}` : undefined,
    kind === 'phone_call' ? 'Say you are calling on behalf of a client. Share only the details given here.' : undefined,
    `Then submit: ${fields.filter((x) => x.required).map((x) => x.label.toLowerCase()).join(', ')}.`,
    'If it cannot be done, say why in the notes instead of guessing.',
  ].filter(Boolean);
  return {
    title: titleFor(kind, estMinutes, shortTask(brief.task), reward),
    kind,
    estMinutes,
    instructions: steps.join('\n'),
    fields,
    summaryTemplate,
    ...(where && { place: { name: where, ...(found && { point: found.point }) } }),
    derivedBy: 'rules',
  };
}

const LlmOut = z.object({
  kind: z.enum(['phone_call', 'on_site', 'errand', 'online', 'other']),
  estMinutes: z.number().int().min(1).max(480),
  shortTask: z.string().min(3).max(60),
  instructions: z.string().min(10).max(1500),
  fields: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/),
        label: z.string().min(1).max(40),
        type: z.enum(['text', 'date', 'time', 'number', 'url', 'phone']),
        required: z.boolean(),
        hint: z.string().max(80).nullable(),
      }),
    )
    .min(1)
    .max(6),
  summaryTemplate: z.string().min(3).max(120),
});

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'estMinutes', 'shortTask', 'instructions', 'fields', 'summaryTemplate'],
  properties: {
    kind: { type: 'string', enum: ['phone_call', 'on_site', 'errand', 'online', 'other'] },
    estMinutes: { type: 'integer' },
    shortTask: { type: 'string' },
    instructions: { type: 'string' },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'label', 'type', 'required', 'hint'],
        properties: {
          key: { type: 'string' },
          label: { type: 'string' },
          type: { type: 'string', enum: ['text', 'date', 'time', 'number', 'url', 'phone'] },
          required: { type: 'boolean' },
          hint: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
    },
    summaryTemplate: { type: 'string' },
  },
};

const SYSTEM = `You turn a client's request into a microtask ("bounty") that a nearby verified person does for a small fee, e.g. a phone call or a quick errand.
Return:
- kind and estMinutes: realistic time for a competent person.
- shortTask: 2 to 6 lower-case words for a list title, e.g. "book a physio slot".
- instructions: plain steps for the worker, using only facts in the request. No invented names, numbers or personal data.
- fields: the structured result the client needs back (1 to 4 fields; snake_case keys). A booking needs date, time and reference. Put free notes and photos aside: they are collected separately.
- summaryTemplate: one line using {key} placeholders for the fields, e.g. "Booked: {date} {time}, ref {reference}".`;

/** Model-drafted spec with a rules fallback; never throws. */
export async function deriveSpec(brief: Brief, config: Config): Promise<BountySpec> {
  const rules = rulesSpec(brief);
  if (!hasLlm(config)) return rules;
  try {
    const out = await structuredCall(
      config,
      { system: SYSTEM, messages: [{ role: 'user', content: JSON.stringify({ task: brief.task, notes: brief.notes, location: brief.location }) }], schema: SCHEMA, maxTokens: 1200 },
      (raw) => LlmOut.parse(raw),
    );
    const keys = new Set(out.fields.map((x) => x.key));
    const placeholders = [...out.summaryTemplate.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    if (!placeholders.length || placeholders.some((k) => !keys.has(k))) return rules;
    const reward = rewardFor(brief, out.estMinutes);
    return {
      ...rules,
      title: titleFor(out.kind, out.estMinutes, out.shortTask, reward),
      kind: out.kind,
      estMinutes: out.estMinutes,
      instructions: out.instructions,
      fields: out.fields.map((x) => f(x.key, x.label, x.type, x.required, x.hint ?? undefined)),
      summaryTemplate: out.summaryTemplate,
      derivedBy: 'llm',
    };
  } catch (err) {
    console.error('[bounty] spec from model failed, using rules:', err instanceof Error ? err.message : err);
    return rules;
  }
}

// ------------------------------------------------------------------ results

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function show(type: ResultField['type'], v: string): string {
  if (type === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (m) return WEEKDAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()]!;
  }
  if (type === 'time') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v);
    if (m) {
      const h = Number(m[1]);
      const suffix = h >= 12 ? 'pm' : 'am';
      const h12 = h % 12 === 0 ? 12 : h % 12;
      return m[2] === '00' ? `${h12}${suffix}` : `${h12}:${m[2]}${suffix}`;
    }
  }
  return v;
}

/** Fills the summary template, e.g. "Booked: Thursday 3pm, ref 88213". */
export function summarize(spec: BountySpec, data: Record<string, string>): string {
  const types = new Map(spec.fields.map((x) => [x.key, x.type]));
  return spec.summaryTemplate
    .replace(/\{(\w+)\}/g, (_, k: string) => (data[k] ? show(types.get(k) ?? 'text', data[k]) : '?'))
    .replace(/\s+/g, ' ')
    .trim();
}

const CHECK: Record<ResultField['type'], (v: string) => boolean> = {
  text: (v) => v.length <= 500,
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) || /^[A-Za-z]{3,9}( \d{1,2}( [A-Za-z]{3,9})?)?$/.test(v),
  time: (v) => /^\d{1,2}:\d{2}$/.test(v) || /^\d{1,2}(:\d{2})?\s*(am|pm)$/i.test(v),
  number: (v) => /^-?\d+(\.\d+)?$/.test(v),
  url: (v) => /^https?:\/\/\S+$/.test(v),
  phone: (v) => /^\+?[\d\s()-]{6,20}$/.test(v),
};

/** Validates worker input against the spec. Unknown keys are dropped. */
export function validateResult(spec: BountySpec, input: Record<string, unknown>): { ok: true; data: Record<string, string> } | { ok: false; errors: string[] } {
  const data: Record<string, string> = {};
  const errors: string[] = [];
  for (const field of spec.fields) {
    const raw = input[field.key];
    const v = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
    if (!v) {
      if (field.required) errors.push(`${field.label} is required`);
      continue;
    }
    if (!CHECK[field.type](v)) errors.push(`${field.label} does not look like a ${field.type}`);
    else data[field.key] = v;
  }
  return errors.length ? { ok: false, errors } : { ok: true, data };
}
