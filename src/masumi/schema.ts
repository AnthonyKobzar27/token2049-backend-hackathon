// MIP-003 input schemas (start_job brief, awaiting_input check-in) and parsers back into domain types.
import { z } from 'zod';
import type { Brief, Shortlist, UserInput } from '../domain/types';

export interface InputField {
  id: string;
  type: 'string' | 'number' | 'boolean' | 'option' | 'none';
  name: string;
  data?: { description?: string; placeholder?: string; values?: string[] };
  validations?: { validation: 'min' | 'max' | 'format' | 'optional'; value: string }[];
}
export interface InputSchema {
  input_data: InputField[];
}

const optional = [{ validation: 'optional', value: 'true' }] as const;
const opt = (f: Omit<InputField, 'validations'>): InputField => ({ ...f, validations: [...optional] });

export const BRIEF_SCHEMA: InputSchema = {
  input_data: [
    { id: 'task', type: 'string', name: 'Task', data: { description: 'What you need done, in a sentence or two' } },
    opt({ id: 'skills', type: 'string', name: 'Skills', data: { description: 'Comma-separated, e.g. "figma, branding"' } }),
    opt({ id: 'budget_usd', type: 'number', name: 'Budget (USD)', data: { description: 'Ceiling for the whole job' } }),
    opt({ id: 'deadline_days', type: 'number', name: 'Deadline (days)', data: { description: 'Days from now until delivery' } }),
    opt({ id: 'location', type: 'string', name: 'Location', data: { description: 'Country or city the freelancer should be in or near' } }),
    opt({ id: 'remote_ok', type: 'boolean', name: 'Remote OK', data: { description: 'False when the work must be on site (default true)' } }),
    opt({ id: 'hours_needed', type: 'number', name: 'Hours needed', data: { description: 'Estimated hours of work' } }),
    opt({ id: 'language', type: 'string', name: 'Language', data: { description: 'ISO 639-1 code the freelancer must work in, e.g. "en"' } }),
    opt({ id: 'timezone', type: 'string', name: 'Timezone', data: { description: 'Your IANA timezone, e.g. "Europe/Zurich"' } }),
    opt({ id: 'notes', type: 'string', name: 'Notes', data: { description: 'Anything else the freelancer should know' } }),
  ],
};

// ------------------------------------------------------------ input_data

/** Accepts a plain object, or a list of {id|key|name, value} entries (older MIP-003 clients). */
export function normalizeInputData(raw: unknown): Record<string, unknown> | null {
  if (Array.isArray(raw)) {
    const out: Record<string, unknown> = {};
    for (const item of raw) {
      if (!item || typeof item !== 'object') return null;
      const e = item as Record<string, unknown>;
      const k = e.id ?? e.key ?? e.name;
      if (typeof k !== 'string' || !('value' in e)) return null;
      out[k] = e.value;
    }
    return out;
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
}

const blank = (v: unknown) => (v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v);
const text = z.preprocess(blank, z.string().trim().optional());
const positive = z.preprocess(blank, z.coerce.number().positive().finite().optional());
const flag = z.preprocess((v) => {
  const b = blank(v);
  if (typeof b !== 'string') return b;
  const s = b.trim().toLowerCase();
  return ['true', 'yes', '1'].includes(s) ? true : ['false', 'no', '0'].includes(s) ? false : b;
}, z.boolean().optional());
const list = z.preprocess(blank, z.union([z.string(), z.array(z.string())]).optional());

const briefFields = z.object({
  task: z.preprocess(blank, z.string().trim().min(1, 'required')),
  skills: list,
  budget_usd: positive,
  deadline_days: positive,
  location: text,
  remote_ok: flag,
  hours_needed: positive,
  language: text,
  timezone: text,
  notes: text,
});

const camel: Record<string, string> = {
  budgetUsd: 'budget_usd',
  deadlineDays: 'deadline_days',
  remoteOk: 'remote_ok',
  hoursNeeded: 'hours_needed',
};

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'input_data'}: ${i.message}`);

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** MIP-003 start_job `input_data` to a Brief. */
export function parseBrief(raw: unknown): Parsed<Brief> {
  const data = normalizeInputData(raw);
  if (!data) return { ok: false, errors: ['input_data: expected an object (or a list of {id, value})'] };
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) flat[camel[k] ?? k] = v;
  const r = briefFields.safeParse(flat);
  if (!r.success) return { ok: false, errors: issues(r.error) };
  const d = r.data;
  const skills = (Array.isArray(d.skills) ? d.skills : (d.skills ?? '').split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  const brief: Brief = { task: d.task, skills, remoteOk: d.remote_ok ?? true };
  if (d.budget_usd !== undefined) brief.budgetUsd = d.budget_usd;
  if (d.deadline_days !== undefined) brief.deadlineDays = d.deadline_days;
  if (d.location) brief.location = d.location;
  if (d.timezone) brief.timezone = d.timezone;
  if (d.hours_needed !== undefined) brief.hoursNeeded = d.hours_needed;
  if (d.language) brief.language = d.language;
  if (d.notes) brief.notes = d.notes;
  return { ok: true, value: brief };
}

// -------------------------------------------------------------- check-in

export const DIFFERENT_OPTIONS = 'different_options';
export const CANCEL = 'cancel';
const SEP = ' | ';

const label = (c: Shortlist['candidates'][number]): string =>
  `${c.profile.id}${SEP}${c.profile.name} (score ${Math.round(c.score)}/100${c.quoteUsd !== undefined ? `, about $${Math.round(c.quoteUsd)}` : ''})`;

/** The input_schema shown with status awaiting_input: pick one candidate, ask for others, or cancel. */
export function checkInSchema(shortlist: Shortlist | null): InputSchema {
  const values = [...(shortlist?.candidates ?? []).map(label), DIFFERENT_OPTIONS, CANCEL];
  return {
    input_data: [
      {
        id: 'choice',
        type: 'option',
        name: 'Your choice',
        data: {
          description: `Pick one freelancer to book, "${DIFFERENT_OPTIONS}" to see other candidates, or "${CANCEL}" to stop without booking`,
          values,
        },
        validations: [
          { validation: 'min', value: '1' },
          { validation: 'max', value: '1' },
        ],
      },
      opt({ id: 'feedback', type: 'string', name: 'Feedback', data: { description: 'What to change when asking for different options (optional)' } }),
    ],
  };
}

const checkIn = z.object({
  choice: z.preprocess((v) => (Array.isArray(v) && v.length === 1 ? v[0] : v), z.string().trim().min(1, 'required')).optional(),
  feedback: text,
});

/** check-in `input_data` to a UserInput. A bare `feedback` without a choice counts as a refine. */
export function parseCheckIn(raw: unknown, shortlist: Shortlist | null): Parsed<UserInput> {
  const data = normalizeInputData(raw);
  if (!data) return { ok: false, errors: ['input_data: expected an object (or a list of {id, value})'] };
  const r = checkIn.safeParse(data);
  if (!r.success) return { ok: false, errors: issues(r.error) };
  const { choice, feedback } = r.data;
  if (!choice) {
    if (feedback) return { ok: true, value: { action: 'refine', feedback } };
    return { ok: false, errors: ['choice: required'] };
  }
  const key = choice.toLowerCase();
  if (key === DIFFERENT_OPTIONS) return { ok: true, value: { action: 'refine', feedback: feedback ?? 'Show me different options' } };
  if (key === CANCEL) return { ok: true, value: { action: 'cancel' } };
  const sep = choice.indexOf(SEP);
  const id = (sep === -1 ? choice : choice.slice(0, sep)).trim();
  if (!shortlist?.candidates.some((c) => c.profile.id === id)) return { ok: false, errors: [`choice: unknown candidate "${id}"`] };
  return { ok: true, value: { action: 'confirm', profileId: id } };
}
