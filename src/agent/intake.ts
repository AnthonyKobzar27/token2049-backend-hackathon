import { z } from 'zod';
import type { Config } from '../config';
import type { Brief, Ms } from '../domain/types';
import { anthropic, hasLlm } from '../llm/client';
import { asTaskType, cleanWhen, describeWhen, enrichBrief, extractPlace, looksOnSite } from './extract';

export interface IntakeTurn {
  from: 'hirer' | 'agent';
  text: string;
}

export type IntakeResult = { kind: 'ask'; text: string } | { kind: 'brief'; brief: Brief; summary: string };

export interface Intake {
  next(history: IntakeTurn[]): Promise<IntakeResult>;
}

const MAX_ASK_ROUNDS = 2;

/**
 * One call to config.MODEL_CHAT with a JSON schema output (no forced tool use: newer
 * models reject it). Returns the parsed JSON, validated by `parse`.
 */
export async function structuredCall<T>(
  config: Config,
  req: { system: string; messages: { role: 'user' | 'assistant'; content: string }[]; schema: Record<string, unknown>; maxTokens?: number },
  parse: (raw: unknown) => T,
): Promise<T> {
  const res = await anthropic(config).messages.create({
    model: config.MODEL_CHAT,
    max_tokens: req.maxTokens ?? 2000,
    system: req.system,
    messages: req.messages,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: req.schema } },
  });
  if (res.stop_reason === 'refusal') throw new Error('model refused the request');
  const block = res.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') throw new Error('model returned no text');
  return parse(JSON.parse(block.text));
}

const nullable = (type: string) => ({ anyOf: [{ type }, { type: 'null' }] });

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'message', 'task', 'skills', 'budgetUsd', 'deadlineDays', 'location', 'timezone', 'remoteOk', 'hoursNeeded', 'language', 'notes', 'whenDate', 'whenStart', 'whenEnd', 'radiusKm', 'taskType'],
  properties: {
    action: { type: 'string', enum: ['ask', 'brief', 'refuse'] },
    message: { type: 'string' },
    task: { type: 'string' },
    skills: { type: 'array', items: { type: 'string' } },
    budgetUsd: nullable('number'),
    deadlineDays: nullable('number'),
    location: nullable('string'),
    timezone: nullable('string'),
    remoteOk: { type: 'boolean' },
    hoursNeeded: nullable('number'),
    language: nullable('string'),
    notes: nullable('string'),
    whenDate: nullable('string'),
    whenStart: nullable('string'),
    whenEnd: nullable('string'),
    radiusKm: nullable('number'),
    taskType: { anyOf: [{ type: 'string', enum: ['in_person', 'remote_creative', 'remote_technical', 'remote_general'] }, { type: 'null' }] },
  },
};

const opt = <T extends z.ZodTypeAny>(t: T) => t.nullish().transform((v) => v ?? undefined);
const Out = z.object({
  action: z.enum(['ask', 'brief', 'refuse']),
  message: z.string().default(''),
  task: z.string().default(''),
  skills: z.array(z.string()).default([]),
  budgetUsd: opt(z.number()),
  deadlineDays: opt(z.number()),
  location: opt(z.string()),
  timezone: opt(z.string()),
  remoteOk: z.boolean().default(true),
  hoursNeeded: opt(z.number()),
  language: opt(z.string()),
  notes: opt(z.string()),
  whenDate: opt(z.string()),
  whenStart: opt(z.string()),
  whenEnd: opt(z.string()),
  radiusKm: opt(z.number()),
  taskType: opt(z.string()),
});

const SYSTEM = `You are the intake step of HAAS, an open router for freelancers. A person describes work they want done; you turn the chat into a structured brief that is used to search freelancer platforms.

Rules:
- Ask a short clarifying question (action "ask", the question in "message") only for what matters and is missing: what exactly is needed, the budget, the deadline, and the location only if the task must be done on site. One message, at most two short questions. Never ask about things you can reasonably infer.
- When you have enough (or the person has no more to add), return action "brief": "task" is a clear one or two sentence description, "skills" are 2 to 5 search terms, "remoteOk" is false only if the work must be done on site, "message" is a one-line plain summary for the person. Set language and timezone only if the person stated them; use null for anything unknown.
- Day and time: if the person says when the work should happen ("Saturday 2-5pm", "tomorrow morning", "Oct 12 at 10"), set whenDate (YYYY-MM-DD, resolved against today's date below) and whenStart/whenEnd (24h "HH:MM", local to the location or stated timezone; a single time means a 2 hour window). Leave them null when no day or time is given; never ask about it for remote work.
- On-site work: set "location" to the most specific place given (district, then city, then country). Set radiusKm only if the person says how far is acceptable.
- taskType: "in_person" for on-site work, else "remote_creative" (design, video, writing, audio), "remote_technical" (software, data, smart contracts) or "remote_general".
- If the task is not legitimate work for a freelancer (solving CAPTCHAs, bypassing a site's controls, fake reviews, anything illegal or harmful), return action "refuse" with a short, polite explanation in "message".
- Fill every field; use "" or [] or null where not applicable. Write in the person's language.`;

const STOPWORDS = new Set('a an and are as at be but by can do for from have i in is it me my need of on or please should that the this to want we with you your some someone'.split(' '));

/** Deterministic brief used without an API key, or when the model fails. */
export function fallbackBrief(history: IntakeTurn[], now: Ms = Date.now()): { brief: Brief; summary: string } {
  const task = history.find((t) => t.from === 'hirer')?.text.trim() ?? '';
  const all = history.filter((t) => t.from === 'hirer').map((t) => t.text).join(' ').toLowerCase();
  const words = (all.match(/[\p{L}\p{N}+#.-]{3,}/gu) ?? []).filter((w) => !STOPWORDS.has(w));
  const skills = [...new Set(words)].slice(0, 4);
  const budget = /\$\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s?(?:usd|dollars?)/.exec(all);
  const hours = /\b(\d+(?:\.\d+)?)\s?(?:hours?|hrs?|h)\b/.exec(all);
  const onSite = looksOnSite(all);
  let brief: Brief = { task, skills, remoteOk: !onSite };
  const b = budget ? Number(budget[1] ?? budget[2]) : undefined;
  if (b) brief.budgetUsd = b;
  if (hours && Number(hours[1]) > 0) brief.hoursNeeded = Number(hours[1]);
  const place = extractPlace(all);
  if (place) brief.location = place;
  if (onSite) brief.taskType = 'in_person';
  brief = enrichBrief({ ...brief, notes: history.filter((t) => t.from === 'hirer').slice(1).map((t) => t.text).join('\n') || undefined }, now);
  if (!brief.notes) delete brief.notes;
  return { brief, summary: summarize(brief) };
}

export function summarize(brief: Brief): string {
  const parts = [brief.task];
  if (brief.skills.length) parts.push(`Skills: ${brief.skills.join(', ')}`);
  if (brief.budgetUsd !== undefined) parts.push(`Budget: up to $${brief.budgetUsd}`);
  if (brief.deadlineDays !== undefined) parts.push(`Deadline: ${brief.deadlineDays} days`);
  if (brief.location) parts.push(`Location: ${brief.location}${!brief.remoteOk && brief.radiusKm !== undefined ? ` (within ${brief.radiusKm} km)` : ''}`);
  const when = describeWhen(brief.when);
  if (when) parts.push(`When: ${when}`);
  parts.push(brief.remoteOk ? 'Remote is fine' : 'On site');
  return parts.join('\n');
}

export function createIntake(deps: { config: Config; now?: () => Ms }): Intake {
  const { config } = deps;
  const clock = deps.now ?? Date.now;
  return {
    async next(history) {
      if (!hasLlm(config)) return { kind: 'brief', ...fallbackBrief(history, clock()) };

      const rounds = history.filter((t) => t.from === 'agent').length;
      const now = clock();
      const today = new Date(now);
      const dated = `${SYSTEM}\n\nToday is ${today.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })} ${today.toISOString().slice(0, 10)} (UTC).`;
      const system = rounds >= MAX_ASK_ROUNDS
        ? `${dated}\n\nYou have already asked ${rounds} clarifying rounds: do not ask again. Return a brief with what you have (or refuse).`
        : dated;
      const messages = history.map((t) => ({ role: t.from === 'hirer' ? ('user' as const) : ('assistant' as const), content: t.text }));
      if (messages[0]?.role !== 'user') return { kind: 'ask', text: 'What do you need done?' };

      let out: z.infer<typeof Out>;
      try {
        out = await structuredCall(config, { system, messages, schema: SCHEMA }, (raw) => Out.parse(raw));
      } catch (err) {
        console.error('[intake] model call failed, using fallback brief:', err);
        return { kind: 'brief', ...fallbackBrief(history, now) };
      }

      if (out.action === 'refuse') return { kind: 'ask', text: out.message || 'Sorry, I cannot help with that kind of task.' };
      if (out.action === 'ask' && rounds < MAX_ASK_ROUNDS && out.message.trim()) return { kind: 'ask', text: out.message.trim() };
      if (out.action === 'ask' || !out.task.trim()) return { kind: 'brief', ...fallbackBrief(history, now) };

      const brief: Brief = { task: out.task.trim(), skills: out.skills.slice(0, 5), remoteOk: out.remoteOk };
      if (out.budgetUsd !== undefined) brief.budgetUsd = out.budgetUsd;
      if (out.deadlineDays !== undefined) brief.deadlineDays = out.deadlineDays;
      if (out.location) brief.location = out.location;
      if (out.timezone) brief.timezone = out.timezone;
      if (out.hoursNeeded !== undefined) brief.hoursNeeded = out.hoursNeeded;
      if (out.language) brief.language = out.language;
      if (out.notes) brief.notes = out.notes;
      if (out.radiusKm !== undefined && out.radiusKm > 0) brief.radiusKm = out.radiusKm;
      const taskType = asTaskType(out.taskType);
      if (taskType) brief.taskType = taskType;
      const when = cleanWhen({ date: out.whenDate, start: out.whenStart, end: out.whenEnd });
      if (when) brief.when = when;
      // Whatever the model left out, read deterministically from what the person wrote.
      const said = history.filter((t) => t.from === 'hirer').map((t) => t.text).join('\n');
      if (!brief.when) {
        const fromText = enrichBrief({ ...brief, task: said, notes: undefined }, now).when;
        if (fromText) brief.when = fromText;
      }
      if (!brief.location && !brief.remoteOk) {
        const place = extractPlace(said);
        if (place) brief.location = place;
      }
      return { kind: 'brief', brief, summary: summarize(brief) };
    },
  };
}
