// Deterministic extraction of place, on-site need and day/time from free text. Used by intake
// (with or without a model) and by the agent-facing APIs, so a brief like "pick up a parcel in
// Marina Bay on Saturday 2-5pm" is routed on distance and time even when the caller sent no
// structured fields.

import type { Brief, BriefWhen, Ms, TaskType } from '../domain/types';
import { placeLabel, resolvePlace } from '../router/geo';
import { briefZone, hhmm, parseWhen } from '../router/when';
import { keywords, languageCode } from '../sources/http';

const ON_SITE = /\b(on[- ]?site|in[- ]person|onsite|errands?|pick ?up|pickup|collect|drop[- ]?off|deliver(y|ies)?|courier|queue|queu(e|ing) for|stand in line|event staff|usher|booth|venue|help (me )?move|moving|assemble|handyman|clean(ing)?|walk (my )?dog|photograph(er|y)? (at|for) (my|our|the) (event|wedding|party|conference))\b/;
const REMOTE = /\b(remote(ly)?|online|anywhere|virtual)\b/;

/** The place named in the text, as a display label ("Marina Bay"), or undefined. */
export function extractPlace(text: string): string | undefined {
  const place = resolvePlace(text);
  return place ? placeLabel(place) : undefined;
}

/** True when the text describes physical, on-site work (and does not say remote). */
export const looksOnSite = (text: string): boolean => {
  const s = text.toLowerCase();
  return ON_SITE.test(s) && !REMOTE.test(s);
};

const TASK_TYPES: TaskType[] = ['in_person', 'remote_creative', 'remote_technical', 'remote_general'];
export const asTaskType = (v: unknown): TaskType | undefined => (typeof v === 'string' && (TASK_TYPES as string[]).includes(v) ? (v as TaskType) : undefined);

/** Validates a structured `when` (from a model or an API caller); drops what does not parse. */
export function cleanWhen(raw: { date?: unknown; start?: unknown; end?: unknown; timezone?: unknown } | undefined | null): BriefWhen | undefined {
  if (!raw) return undefined;
  const out: BriefWhen = {};
  if (typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)) out.date = raw.date;
  if (typeof raw.start === 'string' && typeof raw.end === 'string') {
    const s = hhmm(raw.start);
    const e = hhmm(raw.end);
    if (s !== null && e !== null && e > s) out.window = { start: raw.start.trim().padStart(5, '0'), end: raw.end.trim().padStart(5, '0') };
  }
  if (typeof raw.timezone === 'string' && raw.timezone.trim()) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: raw.timezone.trim() });
      out.timezone = raw.timezone.trim();
    } catch {
      // unknown zone: the brief's own zone applies
    }
  }
  return out.date || out.window ? out : undefined;
}

/**
 * Fills what the text says and the brief leaves out: `when` from the task and notes, and
 * `location` when the work is on site. Never overrides a field that is already set.
 */
export function enrichBrief(brief: Brief, now: Ms = Date.now()): Brief {
  const text = [brief.task, brief.notes].filter(Boolean).join('\n');
  const out: Brief = { ...brief };
  const terms = extractTerms(text);
  if (out.budgetUsd === undefined && terms.budgetUsd !== undefined) out.budgetUsd = terms.budgetUsd;
  if (out.hoursNeeded === undefined && terms.hoursNeeded !== undefined) out.hoursNeeded = terms.hoursNeeded;
  if (out.deadlineDays === undefined && terms.deadlineDays !== undefined) out.deadlineDays = terms.deadlineDays;
  if (!out.language && terms.language) out.language = terms.language;
  if (!out.location) {
    // On-site work needs the place; remote work keeps a named place as a soft preference.
    const place = extractPlace(text);
    if (place) out.location = place;
  }
  if (!out.skills?.length) {
    // Skill words for searching, without the place ("photographer in Marina Bay" searches "photographer").
    const placeWords = new Set((out.location ?? '').toLowerCase().split(/\W+/).filter(Boolean));
    out.skills = keywords(brief.task, 6).filter((w) => !placeWords.has(w)).slice(0, 3);
  }
  if (!out.when) {
    const when = parseWhen(text, now, briefZone(out));
    if (when) out.when = when;
  }
  return out;
}

export interface ExtractedTerms {
  budgetUsd?: number;
  hoursNeeded?: number;
  deadlineDays?: number;
  /** ISO 639-1 code of the language the worker must speak. */
  language?: string;
}

const LANGUAGE_PHRASES = [
  /\b(?:speaks?|speaking|fluent in|native(?: speaker of)?|who knows|in|taught in|lessons in|conducted in)\s+([A-Za-z]+)\b/gi,
  /\b([A-Za-z]+)[- ]speak(?:ing|er)\b/gi,
];

/** The language named as a requirement ("in Spanish", "Mandarin-speaking", "speaks French"). */
export function extractLanguage(text: string): string | undefined {
  for (const re of LANGUAGE_PHRASES) {
    for (const m of text.matchAll(re)) {
      const word = m[1]!;
      // Only real language names, written as names ("in Spanish", not "in person" or "in Singapore").
      if (word.length < 4 || word[0] !== word[0]!.toUpperCase()) continue;
      const code = languageCode(word.toLowerCase());
      if (code) return code;
    }
  }
  return undefined;
}

/** Rough USD per unit for budgets written in other currencies. */
const TO_USD: Record<string, number> = { S$: 0.74, SGD: 0.74, '£': 1.27, GBP: 1.27, '€': 1.08, EUR: 1.08, A$: 0.65, AUD: 0.65, C$: 0.73, CAD: 0.73, '₹': 0.012, INR: 0.012 };

/**
 * Pay, duration and deadline as people text them: "$80", "budget 80", "S$50", "$20/hr",
 * "2 hours", "90 minutes", "within 3 days". An hourly rate becomes a total when the hours are known.
 */
export function extractTerms(text: string): ExtractedTerms {
  const s = text.replace(/,(?=\d{3}\b)/g, '');
  const out: ExtractedTerms = {};
  const minutes = /\b(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\b/i.exec(s);
  const hours = /\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b(?!\s*\/)/i.exec(s);
  if (hours && Number(hours[1]) > 0) out.hoursNeeded = Number(hours[1]);
  else if (minutes && Number(minutes[1]) > 0) out.hoursNeeded = Math.round((Number(minutes[1]) / 60) * 100) / 100;

  const money =
    /(S\$|A\$|C\$|US\$|\$|£|€|₹)\s?(\d+(?:\.\d+)?)\s*(k\b)?(\s*(?:\/|per|an|a)\s*(?:hour|hr|h)\b)?/i.exec(s) ??
    /\b(\d+(?:\.\d+)?)\s*(k\b)?\s*(usd|sgd|gbp|eur|aud|cad|inr|dollars?|bucks)\b(\s*(?:\/|per|an|a)\s*(?:hour|hr|h)\b)?/i.exec(s) ??
    /\b(?:budget|pay|paying|up to|max(?:imum)?|under)\s*(?:is|of|:)?\s*(\d+(?:\.\d+)?)\b/i.exec(s);
  if (money) {
    let amount: number;
    let unit = 'USD';
    let hourly = false;
    if (money[0].match(/^(S\$|A\$|C\$|US\$|\$|£|€|₹)/i)) {
      unit = money[1]!.toUpperCase() === 'US$' ? 'USD' : money[1]!.toUpperCase();
      amount = Number(money[2]) * (money[3] ? 1000 : 1);
      hourly = !!money[4];
    } else if (money.length > 4) {
      amount = Number(money[1]) * (money[2] ? 1000 : 1);
      const cur = money[3]!.toUpperCase();
      unit = /DOLLAR|BUCK/.test(cur) ? 'USD' : cur;
      hourly = !!money[4];
    } else {
      amount = Number(money[1]);
    }
    const usd = amount * (unit === 'USD' || unit === '$' ? 1 : (TO_USD[unit] ?? 1));
    const total = hourly ? usd * (out.hoursNeeded ?? 1) : usd;
    if (total > 0) out.budgetUsd = Math.round(total * 100) / 100;
  }

  const language = extractLanguage(s);
  if (language) out.language = language;

  const within = /\b(?:within|in|next)\s+(\d+)\s*(day|week)s?\b/i.exec(s);
  if (within) out.deadlineDays = Number(within[1]) * (within[2]!.toLowerCase() === 'week' ? 7 : 1);
  else if (/\b(today|tonight|asap|urgent(ly)?)\b/i.test(s)) out.deadlineDays = 1;
  else if (/\btomorrow\b/i.test(s)) out.deadlineDays = 2;
  else if (/\b(this|by the) week(end)?\b/i.test(s)) out.deadlineDays = 7;
  return out;
}

/** "Sat 10/10 14:00-17:00" style summary of a brief's `when`, for confirmations. */
export function describeWhen(when: BriefWhen | undefined): string | undefined {
  if (!when || (!when.date && !when.window)) return undefined;
  const parts: string[] = [];
  if (when.date) {
    const [y, m, d] = when.date.split('-').map(Number) as [number, number, number];
    const wd = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
    parts.push(`${wd} ${when.date}`);
  }
  if (when.window) parts.push(`${when.window.start}-${when.window.end}`);
  if (when.timezone) parts.push(`(${when.timezone})`);
  return parts.join(' ');
}
