// Pure, deterministic matching: quote, hard filters, subscores, score, explanation, rank.

import type { Brief, Candidate, FreelancerProfile, Ms, Subscores, SuitabilityScore } from '../domain/types';
import { distanceKm, matchPlace, placeLabel, profilePlace, profileTimezone, resolvePlace } from './geo';
import { languageCode } from '../sources/http';
import { DEFAULT_WEIGHTS, type Weights } from './weights';

/** A language as a comparable key: its ISO code when known, else the lower-cased name. */
const sameLanguage = (l: string): string => {
  const t = l.trim().toLowerCase();
  return /^[a-z]{2,3}$/.test(t) ? t : (languageCode(t) ?? t);
};
import { timingPhrase, timingScore } from './when';

const BUDGET_TOLERANCE = 1.1;
const PRIOR_MEAN = 4.5;
const PRIOR_WEIGHT = 10;
const UNKNOWN_PENALTY = 2;
/** On-site work: default distance from a named city within which people are kept. */
export const DEFAULT_RADIUS_KM = 50;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const money = (n: number): string => `$${n >= 100 ? Math.round(n) : Math.round(n * 100) / 100}`;

// ------------------------------------------------------------------ quote

export interface Quote {
  quoteUsd?: number;
  pricingIndex?: number;
}

/** Cheapest pricing that meets the deadline (else cheapest overall), priced for this brief. */
export function quote(brief: Brief, profile: FreelancerProfile): Quote {
  const items = profile.pricing.map((p, i) => ({
    i,
    p,
    est: p.kind === 'fixed' ? p.amountUsd : brief.hoursNeeded !== undefined ? p.amountUsd * brief.hoursNeeded : undefined,
  }));
  if (items.length === 0) return {};
  const fits = items.filter((x) => brief.deadlineDays === undefined || x.p.deliveryDays === undefined || x.p.deliveryDays <= brief.deadlineDays);
  const pool = fits.length > 0 ? fits : items;
  const known = pool.filter((x) => x.est !== undefined);
  if (known.length > 0) {
    const best = known.reduce((a, b) => (b.est! < a.est! ? b : a));
    return { quoteUsd: best.est, pricingIndex: best.i };
  }
  const best = pool.reduce((a, b) => (b.p.amountUsd < a.p.amountUsd ? b : a));
  return { pricingIndex: best.i };
}

// ---------------------------------------------------------- hard filters

/** The reason a profile is dropped, or null. Only KNOWN violations drop; unknown never does. */
export function dropReason(brief: Brief, profile: FreelancerProfile, q: Quote = quote(brief, profile)): string | null {
  if (brief.budgetUsd !== undefined && q.quoteUsd !== undefined && q.quoteUsd > brief.budgetUsd * BUDGET_TOLERANCE) return 'over budget';

  if (brief.deadlineDays !== undefined && profile.pricing.length > 0) {
    const allKnown = profile.pricing.every((p) => p.deliveryDays !== undefined);
    if (allKnown && profile.pricing.every((p) => p.deliveryDays! > brief.deadlineDays!)) return 'misses deadline';
  }

  if (brief.language && profile.languages && profile.languages.length > 0) {
    // "English", "english", "en" and "EN" are the same language on either side.
    const want = sameLanguage(brief.language);
    if (!profile.languages.some((l) => sameLanguage(l) === want)) return 'language';
  }

  if (locationFit(brief, profile).drop) return 'location';

  const hpw = profile.availability?.hoursPerWeek;
  if (brief.hoursNeeded !== undefined && brief.deadlineDays !== undefined && hpw !== undefined) {
    if (hpw * (brief.deadlineDays / 7) < brief.hoursNeeded) return 'not enough hours';
  }
  return null;
}

// --------------------------------------------------------------- location

export interface LocationFit {
  /** Undefined when the brief states no place (the dimension does not count). */
  score: number | null | undefined;
  /** Known to be out of reach for on-site work. */
  drop: boolean;
  km?: number;
  phrase?: string;
}

/**
 * On-site: distance from the brief's place (city-level when both are known), dropping only
 * beyond the radius or in another country. Remote: a soft preference for the same country or
 * overlapping hours. Unknown is null, never a drop.
 */
export function locationFit(brief: Brief, profile: FreelancerProfile): LocationFit {
  if (!brief.location) return { score: undefined, drop: false };
  const target = resolvePlace(brief.location);
  const where = profilePlace(profile);
  const known = !!(profile.country || profile.city);

  if (brief.remoteOk === false) {
    const radius = brief.radiusKm ?? DEFAULT_RADIUS_KM;
    if (target?.precision === 'city' && where?.precision === 'city') {
      const km = distanceKm(target, where);
      if (km > radius) return { score: 0, drop: true, km };
      const score = km <= 5 ? 1 : Math.max(0.4, 1 - 0.6 * (km / radius));
      const phrase = km < 2 ? `in ${placeLabel(target)}` : `about ${Math.round(km)} km from ${placeLabel(target)}`;
      return { score, drop: false, km, phrase };
    }
    if (!known) return { score: null, drop: false };
    const m = matchPlace(brief.location, profile);
    if (m === 'elsewhere') return { score: 0, drop: true };
    if (m === 'match') {
      // Same country (or a city we cannot place): close enough to keep, not as good as a known distance.
      const label = profile.city ?? (where ? placeLabel(where) : profile.country!);
      return { score: where?.precision === 'city' ? 0.85 : 0.7, drop: false, phrase: `based in ${label}` };
    }
    if (target && where && target.country !== where.country && where.precision === 'country') return { score: 0, drop: true };
    return { score: null, drop: false };
  }

  // Remote: a gentle nudge toward the stated country or region.
  if (!known) return { score: null, drop: false };
  if (target && where) {
    if (target.country === where.country) return { score: 1, drop: false, phrase: `based in ${profile.city ?? placeLabel(where)}` };
    const overlap = workingOverlapHours(target.timezone, profileTimezone(profile) ?? where.timezone);
    return { score: overlap === null ? 0.4 : 0.3 + 0.6 * (overlap / 9), drop: false };
  }
  const m = matchPlace(brief.location, profile);
  return m === 'match' ? { score: 1, drop: false } : m === 'elsewhere' ? { score: 0.4, drop: false } : { score: null, drop: false };
}

// -------------------------------------------------------------- subscores

export interface SetContext {
  medianQuote: number | null;
  medianDelivery: number | null;
}

function offsetHours(tz: string, at: Ms = Date.UTC(2026, 0, 15, 12)): number | null {
  try {
    const ref = new Date(at);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(ref);
    const g = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
    return (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - ref.getTime()) / 3_600_000;
  } catch {
    return null;
  }
}

/** Hours of overlap between two 09:00-18:00 working days (on a given date when `at` is set, for DST). */
export function workingOverlapHours(tzA: string, tzB: string, at?: Ms): number | null {
  const a = offsetHours(tzA, at);
  const b = offsetHours(tzB, at);
  if (a === null || b === null) return null;
  let shift = Math.abs(a - b) % 24;
  if (shift > 12) shift = 24 - shift;
  return Math.max(0, 9 - shift);
}

const chosenPricing = (p: FreelancerProfile, q: Quote) => (q.pricingIndex !== undefined ? p.pricing[q.pricingIndex] : undefined);

export function ratingScore(rating: number | undefined, reviews: number | undefined): number | null {
  if (rating === undefined) return null;
  const n = reviews ?? 0;
  const shrunk = (rating * n + PRIOR_MEAN * PRIOR_WEIGHT) / (n + PRIOR_WEIGHT);
  return clamp01(shrunk - 4);
}

function availabilityScore(brief: Brief, profile: FreelancerProfile): number | null {
  const a = profile.availability;
  const parts: number[] = [];
  if (a?.accepting !== undefined) parts.push(a.accepting ? 1 : 0.2);
  if (a?.online !== undefined) parts.push(a.online ? 1 : 0.4);
  if (a?.responseHours !== undefined) {
    const h = a.responseHours;
    parts.push(h <= 1 ? 1 : h <= 4 ? 0.85 : h <= 12 ? 0.65 : h <= 24 ? 0.5 : h <= 72 ? 0.25 : 0.1);
  }
  if (a?.hoursPerWeek !== undefined) parts.push(clamp01(a.hoursPerWeek / 30));
  const theirZone = profileTimezone(profile);
  if (brief.timezone && theirZone) {
    const overlap = workingOverlapHours(brief.timezone, theirZone);
    if (overlap !== null) parts.push(clamp01(overlap / 6));
  }
  return parts.length === 0 ? null : parts.reduce((x, y) => x + y, 0) / parts.length;
}

export function subscores(brief: Brief, profile: FreelancerProfile, q: Quote, ctx: SetContext, suit?: SuitabilityScore, now: Ms = Date.now()): Subscores {
  let price: number | null = null;
  if (q.quoteUsd !== undefined) {
    if (brief.budgetUsd !== undefined && brief.budgetUsd > 0) price = clamp01(1 - 0.8 * (q.quoteUsd / brief.budgetUsd));
    else if (ctx.medianQuote !== null && ctx.medianQuote > 0) price = clamp01(1 - 0.5 * (q.quoteUsd / ctx.medianQuote));
  }
  let speed: number | null = null;
  const days = chosenPricing(profile, q)?.deliveryDays;
  if (days !== undefined) {
    if (brief.deadlineDays !== undefined && brief.deadlineDays > 0) speed = clamp01(1 - 0.7 * (days / brief.deadlineDays));
    else if (ctx.medianDelivery !== null && ctx.medianDelivery > 0) speed = clamp01(1 - 0.5 * (days / ctx.medianDelivery));
  }
  const out: Subscores = {
    suitability: suit ? clamp01(suit.score) : null,
    price,
    rating: ratingScore(profile.rating, profile.reviewCount),
    availability: availabilityScore(brief, profile),
    speed,
  };
  const loc = locationFit(brief, profile).score;
  if (loc !== undefined) out.location = loc === null ? null : clamp01(loc);
  const timing = timingScore(brief, profile, now);
  if (timing !== undefined) out.timing = timing;
  return out;
}

/**
 * 0-100: weighted mean over known subscores, minus a small penalty per unknown one.
 * Absent (undefined) dimensions and zero weights do not count at all.
 */
export function totalScore(s: Subscores, weights: Weights = DEFAULT_WEIGHTS): number {
  let sum = 0;
  let w = 0;
  let unknown = 0;
  for (const k of Object.keys(weights) as (keyof Subscores)[]) {
    const v = s[k];
    const wk = weights[k];
    if (v === undefined || !(wk > 0)) continue;
    if (v === null) unknown++;
    else {
      sum += v * wk;
      w += wk;
    }
  }
  let total = w > 0 ? (sum / w) * 100 - unknown * UNKNOWN_PENALTY : 0;
  if (s.suitability !== null && s.suitability < 0.25) total = Math.min(total, 40);
  return Math.round(Math.min(100, Math.max(0, total)) * 10) / 10;
}

// ------------------------------------------------------- on-chain identity

/** What the chain says about a worker (src/identity), read from cache so ranking never waits on it. */
export interface OnChainSignal {
  /** Holds a HAAS Verified Worker credential that is still in the bound wallet. */
  verified: boolean;
  /** Completed, paid jobs recorded on chain. */
  jobsCompleted: number;
  /** 0 to 5, when any job was rated. */
  avgRating?: number;
  /** The credential behind `verified` includes a verified Veridian (KERI ACDC) credential (src/identity/veridian). */
  veridian?: boolean;
  /** The credential behind `verified` includes the Cardano CIP-68 credential, confirmed on chain. */
  cardano?: boolean;
}

const ONCHAIN_MAX_BOOST = 10;

/** Points added to the 0-100 score: 3 for the credential, 0.5 per recorded job (up to 10 jobs), +-2 for rating. */
export function onchainBoost(sig: OnChainSignal | undefined): number {
  if (!sig?.verified) return 0;
  let b = 3 + Math.min(sig.jobsCompleted, 10) * 0.5;
  if (sig.avgRating !== undefined && sig.jobsCompleted > 0) b += Math.max(-2, Math.min(2, (sig.avgRating - 4) * 2));
  return Math.max(0, Math.min(ONCHAIN_MAX_BOOST, b));
}

export function onchainReason(sig: OnChainSignal | undefined): string | null {
  if (!sig?.verified) return null;
  const n = sig.jobsCompleted;
  const who = sig.veridian ? 'Veridian KERI credential verified' : 'on-chain verified';
  return n > 0 ? `${who}, ${n} job${n === 1 ? '' : 's'} completed on HAAS` : `${who} HAAS worker`;
}

// ------------------------------------------------------------ explanation

export function explain(brief: Brief, profile: FreelancerProfile, q: Quote, suit?: SuitabilityScore, now: Ms = Date.now(), onchain?: OnChainSignal): { reason: string; unknowns: string[] } {
  const parts: string[] = [];
  const src = profile.platform;
  const unknowns: string[] = [];
  const pr = chosenPricing(profile, q);

  if (suit?.reason) parts.push(suit.reason.trim().replace(/[.\s]+$/, ''));
  const loc = locationFit(brief, profile);
  if (loc.phrase) parts.push(loc.phrase);
  const when = timingPhrase(brief, profile, now);
  if (when) parts.push(when);
  if (pr) {
    let s = pr.kind === 'fixed' ? `${money(pr.amountUsd)} fixed` : `${money(pr.amountUsd)}/h`;
    if (pr.kind === 'hourly' && q.quoteUsd !== undefined && brief.hoursNeeded !== undefined) s += ` (about ${money(q.quoteUsd)} for ${brief.hoursNeeded}h)`;
    if (pr.deliveryDays !== undefined) s += ` in ${pr.deliveryDays} day${pr.deliveryDays === 1 ? '' : 's'}`;
    parts.push(s);
  }
  if (profile.rating !== undefined) {
    parts.push(profile.reviewCount !== undefined ? `${profile.rating.toFixed(1)} from ${profile.reviewCount} review${profile.reviewCount === 1 ? '' : 's'}` : `rated ${profile.rating.toFixed(1)}`);
  }
  const rh = profile.availability?.responseHours;
  if (rh !== undefined) parts.push(rh < 1 ? 'replies within the hour' : `replies in about ${Math.round(rh)} hour${Math.round(rh) === 1 ? '' : 's'}`);
  else if (profile.availability?.online) parts.push('online now');
  const chainNote = onchainReason(onchain);
  if (chainNote) parts.push(chainNote);

  if (profile.pricing.length === 0) unknowns.push(`price not published on ${src}`);
  else if (q.quoteUsd === undefined) unknowns.push('total cost unknown: hourly rate and no hours estimate');
  if (profile.rating === undefined) unknowns.push(`rating not published on ${src}`);
  else if (profile.reviewCount === undefined) unknowns.push(`review count not published on ${src}`);
  if (profile.availability?.hoursPerWeek === undefined) unknowns.push(`hours per week not published on ${src}`);
  if (rh === undefined) unknowns.push(`response time not published on ${src}`);
  if (pr && pr.deliveryDays === undefined) unknowns.push(`delivery time not published on ${src}`);
  if (brief.location && brief.remoteOk === false && !profile.country && !profile.city) unknowns.push(`location not published on ${src}`);
  if (brief.when && (brief.when.date || brief.when.window) && !profileTimezone(profile)) unknowns.push(`time zone and working hours not published on ${src}`);
  if (brief.language && (!profile.languages || profile.languages.length === 0)) unknowns.push(`languages not published on ${src}`);

  const text = parts.length > 0 ? parts.join('; ') : 'Limited information published';
  return { reason: `${text.charAt(0).toUpperCase()}${text.slice(1)}.`, unknowns };
}

// ------------------------------------------------------------------- rank

export interface RankOptions {
  limit: number;
  exclude?: string[];
  /** Per task type, see weights.ts. Defaults to the general remote weights. */
  weights?: Weights;
  /** Clock for day/time scoring (tests). */
  now?: Ms;
  /** Cached on-chain identity by profile id; adds a bounded boost and a note to the reason. */
  onchain?: Map<string, OnChainSignal>;
}

/** Hard-filters, scores, explains and orders profiles; at most ceil(limit*0.6) per platform while others remain. */
export function rank(brief: Brief, profiles: FreelancerProfile[], suitability: Map<string, SuitabilityScore>, opts: RankOptions): Candidate[] {
  const now = opts.now ?? Date.now();
  const excluded = new Set(opts.exclude ?? []);
  const seen = new Set<string>();
  const kept: { profile: FreelancerProfile; q: Quote }[] = [];
  for (const profile of profiles) {
    if (excluded.has(profile.id) || seen.has(profile.id)) continue;
    seen.add(profile.id);
    const q = quote(brief, profile);
    if (dropReason(brief, profile, q) === null) kept.push({ profile, q });
  }

  const ctx: SetContext = {
    medianQuote: median(kept.flatMap((k) => (k.q.quoteUsd !== undefined ? [k.q.quoteUsd] : []))),
    medianDelivery: median(kept.flatMap((k) => { const d = chosenPricing(k.profile, k.q)?.deliveryDays; return d !== undefined ? [d] : []; })),
  };

  const scored: Candidate[] = kept.map(({ profile, q }) => {
    const suit = suitability.get(profile.id);
    const sub = subscores(brief, profile, q, ctx, suit, now);
    const sig = opts.onchain?.get(profile.id);
    const { reason, unknowns } = explain(brief, profile, q, suit, now, sig);
    const base = totalScore(sub, opts.weights);
    // A credential never rescues a poor fit for the task.
    const boost = sub.suitability !== null && sub.suitability < 0.25 ? 0 : onchainBoost(sig);
    const score = boost > 0 ? Math.round(Math.min(100, base + boost) * 10) / 10 : base;
    const c: Candidate = { profile, score, subscores: sub, reason, unknowns };
    if (q.quoteUsd !== undefined) c.quoteUsd = q.quoteUsd;
    if (q.pricingIndex !== undefined) c.pricingIndex = q.pricingIndex;
    if (sig?.verified) {
      const by: Array<'cardano' | 'veridian'> = [...(sig.cardano || !sig.veridian ? ['cardano' as const] : []), ...(sig.veridian ? ['veridian' as const] : [])];
      c.identity = { verified: true, by, jobsCompleted: sig.jobsCompleted, ...(sig.avgRating !== undefined && { avgRating: sig.avgRating }) };
    }
    return c;
  });
  scored.sort((a, b) => b.score - a.score || a.profile.id.localeCompare(b.profile.id));

  const cap = Math.max(1, Math.ceil(opts.limit * 0.6));
  const perPlatform = new Map<string, number>();
  const picked: Candidate[] = [];
  const overflow: Candidate[] = [];
  for (const c of scored) {
    if (picked.length >= opts.limit) break;
    const n = perPlatform.get(c.profile.platform) ?? 0;
    if (n >= cap) overflow.push(c);
    else {
      picked.push(c);
      perPlatform.set(c.profile.platform, n + 1);
    }
  }
  for (const c of overflow) {
    if (picked.length >= opts.limit) break;
    picked.push(c);
  }
  return picked.sort((a, b) => b.score - a.score || a.profile.id.localeCompare(b.profile.id));
}
