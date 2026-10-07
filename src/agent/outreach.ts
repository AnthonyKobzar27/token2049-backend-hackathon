// What a freelancer reads from us: short, casual, like a person booking someone.
// Never internal notes from the intake ("defaulted to…", "no filtering by…") and never anything
// about HAAS, AI, agents, escrow or crypto: payment runs through the platform as usual.
// Everything here is deterministic so the same brief always produces the same message.

import type { Brief } from '../domain/types';

/** Words a freelancer must never read from us: who we are and how we pay. */
const BANNED =
  /\b(haas|human as a service|ai|a\.i\.|artificial intelligence|llm|agents?|agentic|bots?|chatbot|escrow|crypto\w*|blockchain|on[- ]?chain|solana|cardano|usdc|lovelace|wallets?|masumi|sokosumi|x402|smart contracts?|stablecoins?)\b/i;

/** The intake's own bookkeeping, which reads like a form: drop it from task and notes too. */
const BOOKKEEPING =
  /\b(default(ed|s)?|not specified|unspecified|assum(e|ed|ing)|filter(ed|ing)? by|no filtering|appearance|ethnicity|gender|race|requester|hirer)\b/i;

/** Budget wording inside the task, since the budget gets its own line. */
const BUDGET_CLAUSE = /[,;]?\s*(with\s+(a\s+)?)?budget(\s+is)?\s*(of|around|about|~|:)?\s*\$?\s*[\d.,]+\s*(usd|dollars)?\s*(\/\s*h(ou)?r|per\s+hour|an\s+hour|\/h)?/gi;

/** Who is being hired, as the intake tends to name them ("an experienced SAT tutor"). */
const ROLE =
  'tutors?|teachers?|designers?|translators?|interpreters?|writers?|copywriters?|editors?|proofreaders?|developers?|programmers?|engineers?|photographers?|videographers?|illustrators?|artists?|assistants?|helpers?|coaches?|consultants?|specialists?|experts?|professionals?|freelancers?|drivers?|couriers?|cleaners?|guides?|runners?|taskers?|workers?|persons?|people|someone|somebody';

// Request verbs that only make sense to us. "find someone to design a logo" is just "design a logo"
// to the designer; "find an SAT tutor for math prep" keeps the role ("an SAT tutor for math prep")
// because the rest would lose what kind of help it is, and is then opened with "Looking for".
const VERB = '(?:please\\s+)?(?:(?:i\\s+)?(?:need|want)(?:\\s+to\\s+(?:find|hire|book|get))?|find|hire|book|get)\\s+(?:me\\s+)?';
const ROLE_PHRASE = `(?:(?:an?|the|some)\\s+)?(?:[\\w-]+\\s+){0,3}?(?:${ROLE})`;
const LEAD_IN_TO = new RegExp(`^${VERB}${ROLE_PHRASE}\\s+(?:to|who\\s+(?:can|will))\\s+`, 'i');
const LEAD_IN_FOR = new RegExp(`^${VERB}(?=${ROLE_PHRASE}\\s+for\\s)`, 'i');
/** A task that names the person wanted ("an SAT tutor for…"). */
const NAMES_ROLE = new RegExp(`^(?:an?|some)\\s+(?:[\\w-]+\\s+){0,3}?(?:${ROLE})\\s+for\\s`, 'i');

/** "with an experienced SAT tutor" at the end of a clause: that is the reader, so it goes. */
const WITH_ROLE = new RegExp(`\\s*,?\\s+(?:with|by|from)\\s+(?:an?|the|some)\\s+(?:[\\w-]+\\s+){0,3}?(?:${ROLE})\\b(?=\\s*(?:[,.;!?]|$))`, 'gi');

/** Relative days, replaced by the concrete When line whenever the brief has a date ("every Saturday" is a schedule and stays). */
const RELATIVE_DAY =
  /\s*\b(?:the day after tomorrow|(?:today|tomorrow|tonight)(?:\s+(?:morning|afternoon|evening|night))?|this\s+(?:morning|afternoon|evening|weekend)|next\s+week|(?:on\s+|this\s+|next\s+)?(?<!every\s)(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/gi;

/** Clock times ("at 3pm", "from 2-4pm"), replaced by the When line whenever the brief has a time window. */
const CLOCK_TIME =
  /\s*\b(?:at|from|around|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s*(?:-|to|until|till)\s*\d{1,2}(?::\d{2})?)?\s*(?:am|pm)\b|\s*\bat\s+\d{1,2}:\d{2}\b/gi;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Drops sentences that mention HAAS, AI, agents or crypto; returns '' when nothing is left. For any free text sent to a freelancer. */
export function freelancerSafe(text: string | undefined): string {
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => sentences(line).filter((s) => !BANNED.test(s)).join(' '))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Drops banned and intake-bookkeeping sentences; returns '' when nothing is left. */
export function cleanForFreelancer(text: string | undefined): string {
  if (!text) return '';
  return sentences(text)
    .filter((s) => !BANNED.test(s) && !BOOKKEEPING.test(s))
    .join(' ')
    .trim();
}

/** Tidies spaces and punctuation left behind after phrases were cut out. */
function tidy(text: string): string {
  return text
    // A preposition left hanging where a day or time was cut ("starting this Saturday" -> "starting").
    .replace(/[,;]?\s+(?:starting|from|on|at|by)\s*(?=[.,;!?]|$)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,!?;])/g, '$1')
    .replace(/[,;]+(?=[.!?]|$)/g, '')
    .replace(/,{2,}/g, ',')
    .replace(/^[\s,;]+/, '')
    .trim();
}

/** The task in plain words, as the reader would say it: no budget, no "find a tutor", no "tomorrow" when a date is given. */
export function taskForFreelancer(brief: Brief): string {
  let text = cleanForFreelancer(brief.task) || brief.skills.join(', ') || 'a quick job';
  text = text.replace(BUDGET_CLAUSE, '').replace(LEAD_IN_TO, '').replace(LEAD_IN_FOR, '').replace(WITH_ROLE, '');
  if (brief.when?.date) text = text.replace(RELATIVE_DAY, '');
  if (brief.when?.window) text = text.replace(CLOCK_TIME, '');
  text = tidy(text);
  return text.replace(/^[a-z]/, (c) => c.toUpperCase()).replace(/[^.!?]$/, (c) => `${c}.`);
}

/** A short listing title from the task: its first clause, up to about 80 characters. */
export function titleForFreelancer(brief: Brief): string {
  const first = taskForFreelancer(brief).split(/(?<=[.!?])\s|,\s/)[0] ?? brief.task;
  const t = first.replace(/[.!?]+$/, '').replace(/^(?:an?|some)\s+(?=\S)/i, '').replace(/^[a-z]/, (c) => c.toUpperCase()).trim();
  return t.length > 80 ? `${t.slice(0, 77).replace(/\s+\S*$/, '')}...` : t;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Thu 8 Oct, 15:00-17:00 (Asia/Singapore)" from the brief's when. */
export function whenForFreelancer(brief: Brief): string | undefined {
  const w = brief.when;
  if (!w) return undefined;
  let day = w.date;
  const m = w.date && /^(\d{4})-(\d{2})-(\d{2})$/.exec(w.date);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    day = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  }
  const window = w.window ? `${w.window.start}-${w.window.end}` : undefined;
  const tz = w.timezone ?? brief.timezone;
  const main = [day, window].filter(Boolean).join(', ');
  return main ? `${main}${tz ? ` (${tz})` : ''}` : undefined;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** One timing line: the When with its length, or the length and deadline when there is no date. */
function timingLine(brief: Brief): string {
  const when = whenForFreelancer(brief);
  const hours = brief.hoursNeeded ? plural(brief.hoursNeeded, 'hour') : '';
  if (when) return `When: ${when}${hours ? `, about ${hours}` : ''}`;
  const parts = [brief.deadlineDays ? `need it done within ${plural(brief.deadlineDays, 'day')}` : '', hours ? `should take about ${hours}` : ''].filter(Boolean);
  return parts.length ? `${parts.join(', ').replace(/^./, (c) => c.toUpperCase())}.` : '';
}

/**
 * The first message to a freelancer (or a listing description), at most six short lines.
 * `ask` is the closing line, e.g. asking for a custom offer on Fiverr.
 */
export function outreachMessage(brief: Brief, priceUsd: number, opts: { ask?: string; greeting?: boolean } = {}): string {
  // The budget has its own line, so budget sentences in the notes would only repeat (or contradict) it.
  // Two sentences at most: the message stays a quick text, not a spec.
  const notes = sentences(cleanForFreelancer(brief.notes))
    .filter((x) => !/\bbudget\b|\$\s?\d/i.test(x))
    .slice(0, 2)
    .map((x) => x.replace(/[^.!?]$/, (c) => `${c}.`))
    .join(' ');
  // "for this: wait in line…", but acronyms ("SAT tutoring") and "I" keep their capital.
  const task = taskForFreelancer(brief).replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase());
  // A scheduled remote job is a call or session: say it is online so nobody asks where.
  const where = brief.location && !brief.remoteOk ? `Where: ${brief.location}` : brief.remoteOk && brief.when ? 'Where: online' : '';
  const opener = NAMES_ROLE.test(task) ? `Looking for ${task}` : `Need someone for this: ${task}`;
  const lines = [
    opts.greeting === false ? opener : `Hey! ${opener}`,
    where,
    timingLine(brief),
    priceUsd > 0 ? `Budget is around $${Math.round(priceUsd)}.` : '',
    notes,
    opts.ask ?? "You free? If so, send me an offer and I'll book it. Thanks!",
  ];
  return lines.filter(Boolean).join('\n');
}
