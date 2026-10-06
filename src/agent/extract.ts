// Deterministic extraction of place, on-site need and day/time from free text. Used by intake
// (with or without a model) and by the agent-facing APIs, so a brief like "pick up a parcel in
// Marina Bay on Saturday 2-5pm" is routed on distance and time even when the caller sent no
// structured fields.

import type { Brief, BriefWhen, Ms, TaskType } from '../domain/types';
import { placeLabel, resolvePlace } from '../router/geo';
import { briefZone, hhmm, parseWhen } from '../router/when';

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
  if (!out.location && out.remoteOk === false) {
    const place = extractPlace(text);
    if (place) out.location = place;
  }
  if (!out.when) {
    const when = parseWhen(text, now, briefZone(out));
    if (when) out.when = when;
  }
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
