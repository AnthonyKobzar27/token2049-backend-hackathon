import { choosePlatforms } from '../router/platforms';
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

/** Clarifying rounds before HAAS searches with what it has. */
const MAX_ASK_ROUNDS = 4;

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
- Have a short back-and-forth before searching. Ask (action "ask", the question in "message") for whatever is missing from the essentials below, one friendly message with at most two questions per turn, most important first. Never ask about something the person already said or can be clearly inferred, and accept "flexible", "any" or "don't care" as an answer.
- Essentials for work done IN PERSON (waiting in line, queueing for a launch or tickets, errands, pick-ups and drop-offs, deliveries, checking or photographing something on site, helping at an event): the exact place (address, venue or area), the date, the start time or time window, roughly how long it takes, and the budget.
- Essentials for a LIVE SESSION (tutoring, lessons, coaching, interpreting, calls, meetings): whether online or in person (if in person, also the place), the date and time window, how long, the language, and the budget.
- Essentials for REMOTE DELIVERABLES (design, writing, code, video, research): exactly what should be delivered, the budget, and the deadline.
- If it is unclear whether the work needs someone physically present, ask that first.
- When you have enough (or the person has no more to add), return action "brief": "task" is a clear one or two sentence description, "skills" are 2 to 5 search phrases a buyer would type into a marketplace search box to find the right person or service, understood from what the person actually wants (e.g. "wait in line for the iPhone launch" -> "line sitter", "queue standing", "errand runner"; "help my kid with the SAT" -> "SAT math tutor", "SAT prep"; "my site checkout is broken" -> "Shopify developer", "ecommerce bug fix"), never filler words, dates, budgets or place names, "remoteOk" is false only if the work must be done on site, "message" is a one-line plain summary for the person. Set language and timezone only if the person stated them; use null for anything unknown.
- Day and time: if the person says when the work should happen ("Saturday 2-5pm", "tomorrow morning", "Oct 12 at 10"), set whenDate (YYYY-MM-DD, resolved against today's date below) and whenStart/whenEnd (24h "HH:MM", local to the location or stated timezone; a single time means a 2 hour window, or the stated duration). Leave them null when no day or time is given. Do not ask about day and time for remote deliverables; do ask for in-person work and live sessions.
- hoursNeeded is the duration the person gave (a 2 hour session, about 3 hours in line).
- On-site work: set "location" to the most specific place given (district, then city, then country). Set radiusKm only if the person says how far is acceptable.
- taskType: "in_person" whenever someone must physically be somewhere (waiting in line, queueing, errands, pick-ups, deliveries, checking or photographing something, in-person lessons or help), even if the person did not say "on site"; else "remote_creative" (design, video, writing, audio), "remote_technical" (software, data, smart contracts) or "remote_general".
- If the task is not legitimate work for a freelancer (solving CAPTCHAs, bypassing a site's controls, fake reviews, anything illegal or harmful), return action "refuse" with a short, polite explanation in "message".
- Fill every field; use "" or [] or null where not applicable. Write in the person's language.`;


/** Deterministic brief used without an API key, or when the model fails. */
export function fallbackBrief(history: IntakeTurn[], now: Ms = Date.now()): { brief: Brief; summary: string } {
  const task = history.find((t) => t.from === 'hirer')?.text.trim() ?? '';
  const all = history.filter((t) => t.from === 'hirer').map((t) => t.text).join(' ').toLowerCase();
  // Skill words are picked by enrichBrief (no filler, days, times, budgets or place names).
  const skills: string[] = [];
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

const LIVE_SESSION = /\b(tutor(ing)?|lesson|class|coach(ing)?|teach|interpret(er|ing)?|call|meeting|consult(ation)?|session)\b/i;

/**
 * Without a model: the most important missing essential as one short question, or undefined when
 * the brief has enough. Mirrors the model's rules (place and time for in-person work, time for live
 * sessions, budget always). A topic already asked about is not asked again.
 */
export function missingQuestion(brief: Brief, history: IntakeTurn[]): string | undefined {
  const asked = history.filter((t) => t.from === 'agent').map((t) => t.text.toLowerCase()).join(' ');
  const said = history.filter((t) => t.from === 'hirer').map((t) => t.text.toLowerCase()).join(' ');
  const flexible = /\b(flexible|any ?time|whenever|don'?t care|no preference|anywhere)\b/.test(said);
  const text = [brief.task, brief.notes].filter(Boolean).join(' ');
  const inPerson = brief.remoteOk === false || brief.taskType === 'in_person';
  const live = LIVE_SESSION.test(text);
  const missing: { topic: string; question: string }[] = [];
  if (inPerson && !brief.location) missing.push({ topic: 'where', question: 'Where exactly should they go (address, venue or area)?' });
  if ((inPerson || live) && !brief.when?.date && !flexible) missing.push({ topic: 'when', question: 'What day and time should this happen?' });
  if (live && !inPerson && !/\b(online|remote|zoom|google meet|in person|in-person)\b/.test(said)) missing.push({ topic: 'online', question: 'Should this be online or in person?' });
  if ((inPerson || live) && brief.hoursNeeded === undefined) missing.push({ topic: 'how long', question: 'Roughly how long will it take?' });
  if (brief.budgetUsd === undefined) missing.push({ topic: 'budget', question: "What's your budget?" });
  const next = missing.filter((m) => !asked.includes(m.topic) && !asked.includes(m.question.toLowerCase())).slice(0, 2);
  return next.length ? next.map((m) => m.question).join(' ') : undefined;
}

export function summarize(brief: Brief): string {
  const parts = [brief.task];
  if (brief.skills.length) parts.push(`Skills: ${brief.skills.join(', ')}`);
  if (brief.budgetUsd !== undefined) parts.push(`Budget: up to $${brief.budgetUsd}`);
  if (brief.deadlineDays !== undefined) parts.push(`Deadline: ${brief.deadlineDays} days`);
  if (brief.location) parts.push(`Location: ${brief.location}${!brief.remoteOk && brief.radiusKm !== undefined ? ` (within ${brief.radiusKm} km)` : ''}`);
  const when = describeWhen(brief.when);
  if (when) parts.push(`When: ${when}`);
  if (brief.hoursNeeded !== undefined) parts.push(`Duration: about ${brief.hoursNeeded} h`);
  if (brief.language) parts.push(`Language: ${brief.language}`);
  parts.push(brief.remoteOk ? 'Remote is fine' : 'On site');
  parts.push(choosePlatforms(brief).why);
  return parts.join('\n');
}

export function createIntake(deps: { config: Config; now?: () => Ms }): Intake {
  const { config } = deps;
  const clock = deps.now ?? Date.now;
  return {
    async next(history) {
      if (!hasLlm(config)) {
        const fb = fallbackBrief(history, clock());
        const rounds = history.filter((t) => t.from === 'agent').length;
        const question = rounds < MAX_ASK_ROUNDS ? missingQuestion(fb.brief, history) : undefined;
        return question ? { kind: 'ask', text: question } : { kind: 'brief', ...fb };
      }

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
