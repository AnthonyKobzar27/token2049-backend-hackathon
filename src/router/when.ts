// Day and time: when the brief needs someone, whether a profile works then, and a small
// deterministic parser for phrases like "Saturday 2-5pm" or "tomorrow morning".

import type { Brief, BriefWhen, FreelancerProfile, Ms } from '../domain/types';
import { profileTimezone, resolvePlace } from './geo';

const DAY_MS = 86_400_000;
export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
/** Assumed working day when a profile publishes no schedule. */
const ASSUMED_START = 9 * 60;
const ASSUMED_END = 18 * 60;
const STEP_MIN = 15;

// ------------------------------------------------------------- time zones

interface LocalParts {
  y: number;
  m: number;
  d: number;
  /** Minutes since local midnight. */
  min: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat | null {
  let f = formatters.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'long' });
    } catch {
      return null;
    }
    formatters.set(tz, f);
  }
  return f;
}

/** Local calendar parts of an instant in a zone, or null for an unknown zone. */
export function localParts(at: Ms, tz: string): LocalParts | null {
  const f = formatter(tz);
  if (!f) return null;
  const parts = f.formatToParts(new Date(at));
  const g = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return {
    y: Number(g('year')),
    m: Number(g('month')),
    d: Number(g('day')),
    min: Number(g('hour')) * 60 + Number(g('minute')),
    weekday: WEEKDAYS.indexOf(g('weekday').toLowerCase() as (typeof WEEKDAYS)[number]),
  };
}

/** Zone offset from UTC in minutes at an instant. */
export function offsetMinutes(tz: string, at: Ms): number | null {
  const p = localParts(at, tz);
  if (!p) return null;
  const asUtc = Date.UTC(p.y, p.m - 1, p.d) + p.min * 60_000;
  return Math.round((asUtc - Math.floor(at / 60_000) * 60_000) / 60_000);
}

/** "HH:MM" to minutes; "24:00" allowed. */
export function hhmm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= 24 * 60 && Number(m[2]) < 60 ? v : null;
}
const fmt = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** The UTC instant of a local date and minute-of-day in a zone. */
export function localToUtc(date: string, minutes: number, tz: string): Ms | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + minutes * 60_000;
  const off1 = offsetMinutes(tz, naive);
  if (off1 === null) return null;
  const guess = naive - off1 * 60_000;
  const off2 = offsetMinutes(tz, guess) ?? off1; // second pass settles DST edges
  return naive - off2 * 60_000;
}

const ymd = (p: { y: number; m: number; d: number }): string => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return ymd({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}

// ------------------------------------------------------- requested window

export interface Interval {
  start: Ms;
  end: Ms;
  /** Zone the brief speaks in. */
  tz: string;
  /** e.g. "Sat 14:00-17:00". */
  label: string;
}

/** Zone for the brief's times: explicit, else the brief's own, else the zone of its location, else UTC. */
export function briefZone(brief: Brief): string {
  const tz = brief.when?.timezone ?? brief.timezone ?? resolvePlace(brief.location)?.timezone;
  return tz && formatter(tz) ? tz : 'UTC';
}

/** The concrete interval the brief asks for, or null when it names no day or time. */
export function requestedInterval(brief: Brief, now: Ms = Date.now()): Interval | null {
  const w = brief.when;
  if (!w || (!w.date && !w.window)) return null;
  const tz = briefZone(brief);
  let startMin = ASSUMED_START;
  let endMin = ASSUMED_END;
  if (w.window) {
    const s = hhmm(w.window.start);
    const e = hhmm(w.window.end);
    if (s !== null && e !== null && e > s) {
      startMin = s;
      endMin = e;
    }
  }
  let date = w.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    // A time with no day: the next time that window starts.
    const today = localParts(now, tz)!;
    date = ymd(today);
    if (today.min >= endMin) date = addDays(date, 1);
  }
  const start = localToUtc(date, startMin, tz);
  const end = localToUtc(date, endMin, tz);
  if (start === null || end === null) return null;
  const wd = localParts(start, tz)!.weekday;
  const day = WEEKDAYS[wd]!.slice(0, 1).toUpperCase() + WEEKDAYS[wd]!.slice(1, 3);
  return { start, end, tz, label: w.window ? `${day} ${fmt(startMin)}-${fmt(endMin)}` : `${day} ${date.slice(5).replace('-', '/')}` };
}

// ------------------------------------------------------- profile coverage

export interface Coverage {
  /** Share of the requested interval the person works, 0 to 1. */
  fraction: number;
  /** 'schedule' when the platform published one, 'assumed' for a 09:00-18:00 day in their zone. */
  basis: 'schedule' | 'assumed';
  /** The requested interval in the person's local time, e.g. "07:00-10:00". */
  local: string;
  tz: string;
}

/** How much of the interval falls inside the profile's working hours. Null when their zone is unknown. */
export function coverage(profile: FreelancerProfile, iv: Interval): Coverage | null {
  const tz = profileTimezone(profile);
  if (!tz || !formatter(tz)) return null;
  const schedule = profile.availability?.schedule;
  const hasSchedule = !!schedule && Object.keys(schedule).length > 0;
  const windows = new Map<number, [number, number][]>();
  if (hasSchedule) {
    for (const [day, list] of Object.entries(schedule!)) {
      const wd = WEEKDAYS.indexOf(day.toLowerCase() as (typeof WEEKDAYS)[number]);
      if (wd < 0) continue;
      const ranges: [number, number][] = [];
      for (const r of list ?? []) {
        const s = hhmm(r.start);
        const e = hhmm(r.end);
        if (s !== null && e !== null) {
          if (e > s) ranges.push([s, e]);
          else if (e < s) ranges.push([s, 24 * 60], [0, e]); // overnight
        }
      }
      windows.set(wd, ranges);
    }
  }
  let inside = 0;
  let total = 0;
  for (let t = iv.start; t < iv.end; t += STEP_MIN * 60_000) {
    const p = localParts(t + (STEP_MIN * 60_000) / 2, tz)!;
    total++;
    const ranges = hasSchedule ? windows.get(p.weekday) ?? [] : [[ASSUMED_START, ASSUMED_END] as [number, number]];
    if (ranges.some(([s, e]) => p.min >= s && p.min < e)) inside++;
  }
  const a = localParts(iv.start, tz)!;
  const b = localParts(iv.end, tz)!;
  return { fraction: total === 0 ? 0 : inside / total, basis: hasSchedule ? 'schedule' : 'assumed', local: `${fmt(a.min)}-${fmt(b.min === 0 ? 24 * 60 : b.min)}`, tz };
}

/**
 * 0-1 fit for the brief's day and time; null when the profile's zone is unknown;
 * undefined when the brief names no day or time (the dimension then does not count).
 */
export function timingScore(brief: Brief, profile: FreelancerProfile, now: Ms = Date.now()): number | null | undefined {
  const iv = requestedInterval(brief, now);
  if (!iv) return undefined;
  const cov = coverage(profile, iv);
  let score: number;
  if (cov) score = cov.basis === 'schedule' ? 0.1 + 0.9 * cov.fraction : 0.35 + 0.5 * cov.fraction;
  else return null;
  const a = profile.availability;
  const hoursUntil = (iv.start - now) / 3_600_000;
  if (a?.accepting === false) score *= 0.5;
  if (hoursUntil > 0 && a?.responseHours !== undefined && a.responseHours > hoursUntil) score *= 0.5;
  if (hoursUntil >= 0 && hoursUntil < 6 && a?.online) score += 0.1;
  return Math.min(1, Math.max(0, score));
}

/** A short phrase for the explanation, e.g. "works all of Sat 14:00-17:00". */
export function timingPhrase(brief: Brief, profile: FreelancerProfile, now: Ms = Date.now()): string | undefined {
  const iv = requestedInterval(brief, now);
  if (!iv) return undefined;
  const cov = coverage(profile, iv);
  if (!cov) return undefined;
  const local = cov.tz !== iv.tz ? ` (${cov.local} their time)` : '';
  if (cov.basis === 'schedule') {
    if (cov.fraction >= 0.99) return `available all of ${iv.label}`;
    if (cov.fraction <= 0.01) return `not available ${iv.label}${local}`;
    return `available ${Math.round(cov.fraction * 100)}% of ${iv.label}${local}`;
  }
  if (cov.fraction >= 0.99) return `${iv.label} is within their working day`;
  if (cov.fraction <= 0.01) return `${iv.label} is outside their working day${local}`;
  return `${iv.label} partly in their working day${local}`;
}

// ------------------------------------------------------------------ parse

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PARTS_OF_DAY: Record<string, [number, number]> = { morning: [9 * 60, 12 * 60], afternoon: [13 * 60, 17 * 60], evening: [18 * 60, 21 * 60], tonight: [18 * 60, 22 * 60], night: [19 * 60, 23 * 60], lunch: [12 * 60, 14 * 60] };

/** "2pm", "14:00", "2:30 pm", "14" -> minutes. `ampm` applies to bare numbers that carry none. */
function clock(h: string, m: string | undefined, ap: string | undefined): number | null {
  let hour = Number(h);
  const min = m ? Number(m) : 0;
  if (!Number.isFinite(hour) || hour > 24 || min > 59) return null;
  if (ap) {
    const pm = ap.toLowerCase().startsWith('p');
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
  }
  return hour * 60 + min;
}

/**
 * Finds a day and time in free text ("this Saturday 2-5pm", "tomorrow morning", "2026-10-12 at 10am").
 * Relative days are resolved against `now` in `tz`. Returns undefined when nothing is found.
 */
export function parseWhen(text: string, now: Ms = Date.now(), tz = 'UTC'): BriefWhen | undefined {
  const s = text.toLowerCase();
  const today = localParts(now, tz) ?? localParts(now, 'UTC')!;
  const todayStr = ymd(today);
  let date: string | undefined;

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  const monthDay = new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(s);
  const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.join('|')})[a-z]*\\b`).exec(s);
  const weekday = /\b(?:(next|this|on|coming)\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/.exec(s);
  if (iso) date = `${iso[1]}-${iso[2]}-${iso[3]}`;
  else if (monthDay || dayMonth) {
    const mon = MONTHS.indexOf((monthDay ? monthDay[1] : dayMonth![2])!) + 1;
    const day = Number(monthDay ? monthDay[2] : dayMonth![1]);
    let y = today.y;
    if (mon < today.m || (mon === today.m && day < today.d)) y++;
    if (day >= 1 && day <= 31) date = ymd({ y, m: mon, d: day });
  } else if (/\btomorrow\b/.test(s)) date = addDays(todayStr, 1);
  else if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(s)) date = todayStr;
  else if (weekday && !/\b(every|weekly|per)\s+\w*day/.test(s)) {
    const wd = WEEKDAYS.findIndex((d) => d.startsWith(weekday[2]!));
    let diff = (wd - today.weekday + 7) % 7;
    if (weekday[1] === 'next' && diff === 0) diff = 7;
    date = addDays(todayStr, diff);
  }

  let window: BriefWhen['window'];
  // Only ranges that look like clock times (a colon or am/pm), so "2-3 hours" or "$100-200" never match.
  const range = [...s.matchAll(/\b(?:from\s+|between\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|until|till|and)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/g)].find((r) => r[3] || r[6] || r[2] || r[5]);
  const at = /\b(?:at|@|around)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(s) ?? /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(s);
  if (range) {
    const ap2 = range[6];
    // "2-5pm": the second am/pm carries over to the first when that keeps the order.
    const a = clock(range[1]!, range[2], range[3] ?? (ap2 && Number(range[1]) <= Number(range[4]) ? ap2 : undefined));
    const b = clock(range[4]!, range[5], ap2 ?? range[3]);
    if (a !== null && b !== null && b > a) window = { start: fmt(a), end: fmt(b) };
  } else if (at) {
    let a = clock(at[1]!, at[2], at[3]);
    if (a !== null && !at[3] && a < 7 * 60) a += 12 * 60; // "at 3" means 3pm
    if (a !== null && a < 24 * 60) window = { start: fmt(a), end: fmt(Math.min(24 * 60, a + 120)) };
  } else {
    const part = Object.keys(PARTS_OF_DAY).find((k) => new RegExp(`\\b${k}\\b`).test(s));
    if (part) {
      const [a, b] = PARTS_OF_DAY[part]!;
      window = { start: fmt(a), end: fmt(b) };
    }
  }

  if (!date && !window) return undefined;
  const out: BriefWhen = {};
  if (date) out.date = date;
  if (window) out.window = window;
  if (tz !== 'UTC') out.timezone = tz;
  return out;
}
