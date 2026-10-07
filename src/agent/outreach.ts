// What a freelancer reads from us: short, casual, like a person booking someone.
// Never internal notes from the intake ("defaulted to…", "no filtering by…") and never anything
// about HAAS, agents, escrow or crypto: payment runs through the platform as usual.

import type { Brief } from '../domain/types';

/** Sentences a freelancer must never see: our internals, payment rails, and intake bookkeeping. */
const INTERNAL =
  /\b(haas|human as a service|ai agents?|agents?|escrow|crypto\w*|blockchain|on[- ]?chain|solana|cardano|usdc|lovelace|wallets?|masumi|sokosumi|x402|smart contract|stablecoin|default(ed|s)?|not specified|unspecified|assum(e|ed|ing)|filter(ed|ing)?|appearance|ethnicity|gender|race|requester|hirer)\b/i;

/** Budget wording inside the task, since the budget gets its own line. */
const BUDGET_CLAUSE = /[,;]?\s*(with\s+(a\s+)?)?budget(\s+is)?\s*(of|around|about|~|:)?\s*\$?\s*[\d.,]+\s*(usd|dollars)?\s*(\/\s*h(ou)?r|per\s+hour|an\s+hour|\/h)?/gi;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Drops internal sentences; returns '' when nothing is left. */
export function cleanForFreelancer(text: string | undefined): string {
  if (!text) return '';
  return sentences(text)
    .filter((s) => !INTERNAL.test(s))
    .join(' ')
    .trim();
}

/** The task in plain words, without the budget clause or internal sentences. */
export function taskForFreelancer(brief: Brief): string {
  const cleaned = cleanForFreelancer(brief.task) || brief.task;
  const text = cleaned.replace(BUDGET_CLAUSE, '').replace(/\s+([.,!?])/g, '$1').replace(/[,;]\s*\./g, '.').trim();
  return text.replace(/^[a-z]/, (c) => c.toUpperCase()).replace(/[^.!?]$/, (c) => `${c}.`);
}

/** A short listing title from the task: its first clause, up to about 80 characters. */
export function titleForFreelancer(brief: Brief): string {
  const first = taskForFreelancer(brief).split(/(?<=[.!?])\s|,\s/)[0] ?? brief.task;
  const t = first.replace(/[.!?]+$/, '').trim();
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

/**
 * The first message to a freelancer (or a listing description). `ask` is the closing line,
 * e.g. asking for a custom offer on Fiverr.
 */
export function outreachMessage(brief: Brief, priceUsd: number, opts: { ask?: string; greeting?: boolean } = {}): string {
  const when = whenForFreelancer(brief);
  // The budget has its own line: drop budget sentences from the notes.
  const notes = sentences(cleanForFreelancer(brief.notes)).filter((x) => !/\bbudget\b|\$\s?\d/i.test(x)).join(' ');
  // "for this: wait in line…" (keeps acronyms such as "SAT" as they are).
  const task = taskForFreelancer(brief).replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase());
  const lines = [
    `${opts.greeting === false ? '' : 'Hey! '}Looking to book someone for this: ${task}`,
    brief.location && !brief.remoteOk ? `Where: ${brief.location}` : '',
    when ? `When: ${when}` : '',
    brief.hoursNeeded ? `Should take about ${brief.hoursNeeded} hour${brief.hoursNeeded === 1 ? '' : 's'}.` : '',
    brief.deadlineDays && !when ? `Need it done within ${brief.deadlineDays} day${brief.deadlineDays === 1 ? '' : 's'}.` : '',
    priceUsd > 0 ? `Budget is about $${Math.round(priceUsd)}.` : '',
    notes,
    opts.ask ?? 'You free? If so, send me an offer and I will book it. Thanks!',
  ];
  return lines.filter(Boolean).join('\n');
}
