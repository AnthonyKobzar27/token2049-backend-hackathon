// RentAHuman source. Search and profiles use the public REST API (no key needed).
// Booking (RENTAHUMAN_BOOKING, needs RENTAHUMAN_API_KEY):
// - live: hire the chosen human through RentAHuman's escrow (POST /api/escrow/agent-checkout).
//   Funded from the RentAHuman wallet when it has balance; otherwise a checkout link a person pays.
//   Status follows GET /api/escrow/:id; accepting a delivery calls complete, then release.
//   If agent checkout is unavailable, a funded bounty is posted and the chosen human's application accepted.
// - dry_run: price a bounty without charging (POST /api/bounties with dryRun). handoff: link the profile.
// Docs: https://rentahuman.ai/docs

import type { Config } from '../config';
import type { FreelancerSource, SearchOptions } from '../domain/ports';
import type { BookingRequest, BookingResult, Brief, FreelancerProfile, Ms, PlatformBookingStatus, Pricing } from '../domain/types';
import { findCountry, HttpError, keywords, languageCode, requestJson, toUsd } from './http';

const API = 'https://rentahuman.ai/api';
const SITE = 'https://rentahuman.ai';
/** Unauthenticated limit per request. */
const MAX_UNAUTH = 24;
const MAX_AUTH = 100;

export interface RawHuman {
  id: string;
  name?: string;
  headline?: string;
  bio?: string;
  skills?: string[];
  location?: { city?: string; state?: string; country?: string; isRemoteAvailable?: boolean };
  languages?: string[];
  hourlyRate?: number;
  currency?: string;
  availability?: Record<string, { start: string; end: string }[]>;
  timezone?: string;
  rating?: number;
  reviewCount?: number;
  isAvailable?: boolean;
  isVerified?: boolean;
  teamPick?: boolean;
  isFeatured?: boolean;
  profileUrl?: string;
}

function weeklyHours(avail: RawHuman['availability']): number | undefined {
  if (!avail) return undefined;
  let total = 0;
  for (const windows of Object.values(avail)) {
    for (const w of windows ?? []) {
      const [sh, sm] = w.start.split(':').map(Number);
      const [eh, em] = w.end.split(':').map(Number);
      if ([sh, sm, eh, em].some((n) => n === undefined || Number.isNaN(n))) continue;
      const h = (eh! * 60 + em! - (sh! * 60 + sm!)) / 60;
      if (h > 0) total += h;
    }
  }
  return total > 0 ? Math.round(total * 10) / 10 : undefined;
}

function availabilityOf(h: RawHuman, hours: number | undefined): FreelancerProfile['availability'] {
  const out: NonNullable<FreelancerProfile['availability']> = {};
  if (hours !== undefined) out.hoursPerWeek = hours;
  if (hours !== undefined && h.availability) {
    const schedule: Record<string, { start: string; end: string }[]> = {};
    for (const [day, windows] of Object.entries(h.availability)) if (windows?.length) schedule[day.toLowerCase()] = windows.map((w) => ({ start: w.start, end: w.end }));
    out.schedule = schedule;
  }
  if (typeof h.isAvailable === 'boolean') out.accepting = h.isAvailable;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Pure: one RentAHuman human to our profile. */
export function normaliseHuman(h: RawHuman, fetchedAt: Ms = Date.now()): FreelancerProfile {
  const pricing: Pricing[] = [];
  if (h.hourlyRate && h.hourlyRate > 0) {
    const code = (h.currency ?? 'USD').toUpperCase();
    const usd = toUsd(h.hourlyRate, code);
    if (usd !== undefined) {
      pricing.push({ kind: 'hourly', amountUsd: usd, ...(code !== 'USD' ? { original: { amount: h.hourlyRate, currency: code } } : {}) });
    }
  }
  const languages = [...new Set((h.languages ?? []).map(languageCode).filter((c): c is string => !!c))];
  const hours = weeklyHours(h.availability);
  const reviews = h.reviewCount;
  return {
    id: `rentahuman:${h.id}`,
    platform: 'rentahuman',
    platformId: h.id,
    url: h.profileUrl || `${SITE}/humans/${h.id}`,
    name: h.name?.trim() || `Human ${h.id}`,
    headline: h.headline?.trim() ?? '',
    description: h.bio?.trim() || undefined,
    skills: h.skills ?? [],
    country: h.location?.country || undefined,
    city: h.location?.city || undefined,
    // "UTC" is the profile default, not a statement about where the person works.
    timezone: h.timezone && h.timezone !== 'UTC' ? h.timezone : undefined,
    languages: languages.length ? languages : undefined,
    availability: availabilityOf(h, hours),
    pricing,
    // A zero rating with no reviews means unrated.
    rating: reviews && reviews > 0 && h.rating ? h.rating : undefined,
    reviewCount: reviews,
    level: h.teamPick ? 'Team pick' : h.isFeatured ? 'Featured' : undefined,
    verified: h.isVerified,
    fetchedAt,
  };
}

/** Places that are both a city and a country. */
const CITY_STATES = new Set(['singapore', 'hong kong', 'macau', 'macao', 'monaco', 'vatican city', 'luxembourg']);
const COUNTRY_ALIASES: Record<string, string> = { usa: 'US', us: 'US', 'u.s.': 'US', 'u.s.a.': 'US', america: 'US', uk: 'GB', 'u.k.': 'GB', england: 'GB', uae: 'AE', dubai: 'AE' };
/** Parts of an address that are not a city. */
const NOT_A_CITY = /\d|\b(road|rd|street|st|avenue|ave|lane|blvd|boulevard|drive|way|store|shop|mall|centre|center|building|tower|plaza|station|airport|hotel|park|square|floor|unit|block|near|opposite)\b/i;

/** Pure: a brief's free-text place to a city and an ISO country code, as far as they can be told. */
export function placeOf(location: string): { city?: string; country?: string } {
  const parts = location.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean);
  let country: string | undefined;
  let countryPart = -1;
  for (let i = parts.length - 1; i >= 0 && !country; i--) {
    const alias = COUNTRY_ALIASES[parts[i]!.toLowerCase()];
    const found = alias ? { code: alias } : findCountry(parts[i]!);
    if (found) {
      country = found.code;
      countryPart = i;
    }
  }
  country ??= findCountry(location)?.code;
  let city: string | undefined;
  for (const p of parts) if (CITY_STATES.has(p.toLowerCase())) city = p;
  for (let i = parts.length - 1; i >= 0 && !city; i--) {
    if (i === countryPart) continue;
    const p = parts[i]!;
    if (!NOT_A_CITY.test(p) && p.split(/\s+/).length <= 3) city = p;
  }
  if (city) city = city.replace(/\b\w/g, (c) => c.toUpperCase());
  return { city, country };
}

/** Phrases a brief uses -> words RentAHuman profiles list as skills (matched as substrings). */
const VOCABULARY: [RegExp, string[]][] = [
  [/\b(line|queue|queu\w*|wait\w*)\b/i, ['line standing', 'queue', 'waiting']],
  [/\berrand/i, ['errand']],
  [/\b(pick ?up|collect\w*|fetch)\b/i, ['pickup', 'errand']],
  [/\b(shop\w*|grocer\w*|purchas\w*|buy\w*)\b/i, ['shopping', 'errand']],
  [/\b(deliver\w*|courier|drop ?off|parcel|package)\b/i, ['delivery', 'courier', 'errand']],
  [/\bassistant\b/i, ['assistant', 'errand']],
  [/\b(clean\w*|tidy\w*)\b/i, ['cleaning']],
  [/\b(mov\w*|lift\w*|assembl\w*|labou?r\w*|handyman)\b/i, ['general labor', 'handyman', 'moving']],
  [/\b(dog|pet|cat)s?\b/i, ['dog walking', 'pet']],
  [/\b(photo\w*|video\w*|film\w*)\b/i, ['photography', 'video']],
  [/\b(tutor\w*|teach\w*|lesson\w*|coach\w*)\b/i, ['tutor', 'teaching']],
  [/\b(translat\w*|interpret\w*)\b/i, ['translation']],
  [/\b(event|conference|attend\w*)\b/i, ['event']],
];
/** Words too vague to search alone: "line" matches "Online", "sitter" matches "Pet sitter". */
const VAGUE = new Set(['line', 'sitter', 'runner', 'standing', 'personal', 'general', 'task', 'tasks', 'work', 'worker', 'help', 'helper', 'service', 'services', 'online', 'remote', 'local', 'person', 'people', 'human', 'support', 'data', 'and', 'for', 'the', 'with']);
/** Skill words that suit most on-site errands. */
const ON_SITE = ['errand', 'general labor', 'delivery'];

/** Pure: the brief's skills, then shorter and synonym terms that RentAHuman profiles use. */
export function skillTerms(brief: Brief): { exact: string[]; wide: string[] } {
  const exact = [...new Set((brief.skills.length ? brief.skills : keywords(brief.task, 3)).map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 6);
  const wide = [...exact];
  const add = (t: string): void => {
    if (!wide.includes(t)) wide.push(t);
  };
  for (const skill of exact) for (const w of skill.split(/[\s/&-]+/)) if (w.length >= 4 && !VAGUE.has(w)) add(w);
  const text = [...exact, brief.task].join(' ');
  let mapped = false;
  for (const [re, terms] of VOCABULARY) {
    if (!re.test(text)) continue;
    mapped = true;
    terms.forEach(add);
  }
  // On-site work the vocabulary does not know: errand-type profiles are the nearest fit.
  if (!brief.remoteOk && !mapped) ON_SITE.forEach(add);
  return { exact, wide: wide.slice(0, 20) };
}

/** Most requests one search makes. */
export const MAX_SEARCH_REQUESTS = 10;

/**
 * Pure: the query ladder for a brief, most specific first. Each step relaxes one thing:
 * exact skills -> synonyms -> hourly cap x2 -> no cap -> country instead of city -> any skill in the place
 * -> (last resort) anywhere. Remote work has no place, so it never drops the skill.
 */
export function searchPlan(brief: Brief): { steps: Record<string, string | number>[]; isLocal: (h: RawHuman) => boolean } {
  const { exact, wide } = skillTerms(brief);
  const cap = brief.budgetUsd && brief.budgetUsd > 0 ? Math.ceil(brief.budgetUsd / (brief.hoursNeeded && brief.hoursNeeded > 0 ? brief.hoursNeeded : 1)) : undefined;
  const onSite = !brief.remoteOk && !!brief.location?.trim();
  const place = onSite ? placeOf(brief.location!) : {};
  const near: Record<string, string>[] = [];
  if (place.city) near.push({ city: place.city });
  if (place.country) near.push({ country: place.country });
  // Neither a city nor a country could be told apart: let RentAHuman rank by the whole text.
  if (onSite && !near.length) near.push({ city: brief.location!.trim() });
  const here = near[0] ?? {};
  const rates: Record<string, number>[] = cap ? [{ maxRate: cap }, { maxRate: cap * 2 }, {}] : [{}];
  const skill = (terms: string[]): Record<string, string> => (terms.length ? { skill: terms.join(',') } : {});

  const steps: Record<string, string | number>[] = [];
  steps.push({ ...skill(exact), ...here, ...rates[0] });
  for (const r of rates) steps.push({ ...skill(wide), ...here, ...r });
  for (const n of near.slice(1)) steps.push({ ...skill(wide), ...n });
  if (onSite) {
    for (const n of near) steps.push({ ...n, ...(cap ? { maxRate: cap * 2 } : {}) }, { ...n });
    steps.push({ ...skill(wide) });
  }
  const keyed = new Map(steps.map((s) => [JSON.stringify(Object.entries(s).sort()), s]));
  const unique = [...keyed.values()].slice(0, MAX_SEARCH_REQUESTS);

  const city = place.city?.toLowerCase();
  const isLocal = (h: RawHuman): boolean => {
    if (!onSite || (!place.city && !place.country)) return true;
    const hc = h.location?.city?.trim().toLowerCase();
    if (place.country && h.location?.country?.toUpperCase() === place.country) return true;
    return !!(city && hc && hc === city);
  };
  return { steps: unique, isLocal };
}

export function createRentAHumanSource(config: Config): FreelancerSource {
  const headers = (): Record<string, string> => (config.RENTAHUMAN_API_KEY ? { 'X-API-Key': config.RENTAHUMAN_API_KEY } : {});
  const maxLimit = config.RENTAHUMAN_API_KEY ? MAX_AUTH : MAX_UNAUTH;

  async function query(params: Record<string, string | number>, signal?: AbortSignal): Promise<RawHuman[]> {
    const res = await requestJson<{ humans?: RawHuman[] }>(`${API}/humans`, { query: { limit: maxLimit, ...params }, headers: headers(), signal });
    return res.humans ?? [];
  }

  /**
   * Widens step by step until enough people turn up (see searchPlan). For on-site work only
   * people in the place count; others are kept as a last resort when nobody local is found.
   */
  async function search(brief: Brief, opts: SearchOptions): Promise<FreelancerProfile[]> {
    const plan = searchPlan(brief);
    const enough = Math.max(1, Math.min(opts.limit, 10));
    const found: RawHuman[] = [];
    const elsewhere: RawHuman[] = [];
    const seen = new Set<string>();
    let firstError: unknown;
    for (const step of plan.steps) {
      opts.signal?.throwIfAborted();
      let humans: RawHuman[];
      try {
        humans = await query(step, opts.signal);
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        firstError ??= err;
        continue;
      }
      for (const h of humans) {
        if (!h?.id || seen.has(h.id)) continue;
        seen.add(h.id);
        (plan.isLocal(h) ? found : elsewhere).push(h);
      }
      if (found.length >= enough) break;
    }
    const out = (found.length ? found : elsewhere).slice(0, opts.limit);
    if (!out.length && firstError) throw firstError;
    const now = Date.now();
    return out.map((h) => normaliseHuman(h, now));
  }

  async function getProfile(platformId: string): Promise<FreelancerProfile | null> {
    try {
      const res = await requestJson<{ human?: RawHuman }>(`${API}/humans/${encodeURIComponent(platformId)}`, { headers: headers() });
      return res.human ? normaliseHuman(res.human) : null;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  const handoff = (profile: FreelancerProfile, why = ''): BookingResult => ({
    kind: 'handoff',
    url: profile.url,
    instructions:
      `${why}Open ${profile.name}'s RentAHuman profile and post a request (a bounty) for the task, then accept ${profile.name}'s application.`.trim(),
  });

  const auth = (): Record<string, string> => ({ 'X-API-Key': config.RENTAHUMAN_API_KEY! });

  function bountyBody(request: BookingRequest): Record<string, unknown> {
    const { brief, priceUsd } = request;
    const hours = brief.hoursNeeded && brief.hoursNeeded > 0 ? brief.hoursNeeded : 1;
    const description = [brief.task, brief.notes, brief.location && !brief.remoteOk ? `Location: ${brief.location}` : undefined]
      .filter(Boolean)
      .join('\n')
      .padEnd(20, '.');
    return {
      title: brief.task.slice(0, 200).padEnd(5, '.'),
      description: description.slice(0, 5000),
      completionCriteria: 'Report what was done, with any details the task asks for (times, references, links or photos).',
      evidenceTypes: ['text'],
      price: Math.max(5, Math.round(priceUsd)),
      priceType: 'fixed',
      estimatedHours: Math.max(0.083, hours),
      agentType: 'other',
      ...(brief.location ? { location: { country: brief.location, isRemoteAllowed: brief.remoteOk } } : {}),
    };
  }

  const pick = (o: Record<string, unknown> | undefined, ...keys: string[]): unknown => {
    for (const k of keys) {
      const v = k.split('.').reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), o);
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };

  async function book(request: BookingRequest): Promise<BookingResult> {
    const { profile, bookingId } = request;
    if (!config.RENTAHUMAN_API_KEY || config.RENTAHUMAN_BOOKING === 'handoff') {
      return handoff(profile, config.RENTAHUMAN_API_KEY ? '' : 'No RENTAHUMAN_API_KEY is set, so nothing was booked automatically. ');
    }
    if (config.RENTAHUMAN_BOOKING === 'dry_run') {
      try {
        const res = await requestJson<Record<string, unknown>>(`${API}/bounties`, { method: 'POST', headers: auth(), json: { ...bountyBody(request), dryRun: true } });
        const total = pick(res, 'fundingTotal', 'bounty.fundingTotal', 'data.fundingTotal');
        return handoff(profile, `Dry run: RentAHuman priced this job at ${total !== undefined ? `$${total}` : 'an unknown total'} and nothing was charged. Set RENTAHUMAN_BOOKING=live to hire for real. `);
      } catch (err) {
        return handoff(profile, `The RentAHuman dry run failed (${err instanceof Error ? err.message : String(err)}). `);
      }
    }
    // live: hire this human through escrow.
    try {
      const res = await requestJson<Record<string, unknown>>(`${API}/escrow/agent-checkout`, {
        method: 'POST',
        headers: { ...auth(), 'Idempotency-Key': `haas-${bookingId}` },
        json: {
          humanId: profile.platformId,
          taskTitle: request.brief.task.slice(0, 200),
          taskDescription: bountyBody(request).description,
          price: Math.max(5, Math.round(request.priceUsd)),
          estimatedHours: bountyBody(request).estimatedHours,
          idempotencyKey: `haas-${bookingId}`,
        },
      });
      return escrowResult(profile, res);
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 404 || err.status === 405))) {
        return handoff(profile, `RentAHuman checkout failed (${err instanceof Error ? err.message : String(err)}). `);
      }
    }
    // Agent checkout not available: post a bounty and accept this human when they apply.
    try {
      const res = await requestJson<Record<string, unknown>>(`${API}/bounties`, {
        method: 'POST',
        headers: { ...auth(), 'Idempotency-Key': `haas-${bookingId}` },
        json: { ...bountyBody(request), preferredHumanIds: [profile.platformId], idempotencyKey: `haas-${bookingId}` },
      });
      const id = String(pick(res, 'id', 'bounty.id', 'bountyId') ?? '');
      if (!id) return handoff(profile, 'RentAHuman did not return a bounty id. ');
      const checkout = pick(res, 'checkoutUrl', 'bounty.checkoutUrl', 'url') as string | undefined;
      const status = String(pick(res, 'status', 'bounty.status') ?? '');
      const ref = `bounty:${id}:${profile.platformId}`;
      if (checkout && /awaiting_funding/i.test(status || 'awaiting_funding')) {
        return { kind: 'handoff', url: checkout, platformRef: ref, instructions: `HAAS posted a RentAHuman bounty for ${profile.name}. Pay it at the checkout link to fund the escrow; HAAS accepts ${profile.name} when they apply.` };
      }
      return { kind: 'placed', platformRef: ref, url: `${SITE}/bounties/${id}` };
    } catch (err) {
      return handoff(profile, `Posting the RentAHuman bounty failed (${err instanceof Error ? err.message : String(err)}). `);
    }
  }

  function escrowResult(profile: FreelancerProfile, res: Record<string, unknown>): BookingResult {
    const id = String(pick(res, 'escrowId', 'escrow.id', 'id', 'data.escrowId') ?? '');
    const checkout = pick(res, 'checkoutUrl', 'checkout.url', 'url', 'data.checkoutUrl') as string | undefined;
    const status = String(pick(res, 'status', 'escrow.status', 'data.status') ?? '');
    const funded = pick(res, 'funded', 'escrow.funded') === true || /funded|held|active|paid|in_progress/i.test(status);
    if (!id) return handoff(profile, 'RentAHuman did not return an escrow id. ');
    const ref = `escrow:${id}`;
    if (funded || !checkout) return { kind: 'placed', platformRef: ref, url: profile.url };
    return {
      kind: 'handoff',
      url: checkout,
      platformRef: ref,
      instructions: `HAAS opened a RentAHuman escrow to hire ${profile.name}. Pay it at the checkout link (or top up the RentAHuman wallet); HAAS follows the job from there.`,
    };
  }

  function mapStatus(raw: string): PlatformBookingStatus['status'] {
    const s = raw.toLowerCase();
    if (/cancel|refund|expired|declined|rejected|failed/.test(s)) return 'cancelled';
    if (/released|paid_out|paid|completed|complete|closed/.test(s)) return 'completed';
    if (/submitted|delivered|review|awaiting_approval|pending_release/.test(s)) return 'delivered';
    if (/revision/.test(s)) return 'in_revision';
    if (/accepted|assigned|active|in_progress|funded|held|working/.test(s)) return 'in_progress';
    return 'placed';
  }

  function evidenceText(o: Record<string, unknown> | undefined): { text?: string; urls?: string[] } {
    const ev = pick(o, 'evidence', 'submission', 'submission.evidence', 'delivery', 'proof');
    const items = Array.isArray(ev) ? ev : ev ? [ev] : [];
    const texts: string[] = [];
    const urls: string[] = [];
    for (const item of items) {
      if (typeof item === 'string') (/^https?:\/\//.test(item) ? urls : texts).push(item);
      else if (item && typeof item === 'object') {
        const r = item as Record<string, unknown>;
        const t = pick(r, 'text', 'content', 'description', 'note');
        const u = pick(r, 'url', 'link', 'fileUrl');
        if (typeof t === 'string') texts.push(t);
        if (typeof u === 'string') urls.push(u);
      }
    }
    return { text: texts.join('\n') || undefined, urls: urls.length ? urls : undefined };
  }

  async function escrowIdOf(platformRef: string): Promise<string | undefined> {
    const [kind, id] = platformRef.split(':');
    if (kind === 'escrow') return id;
    if (kind === 'bounty' && id) {
      const b = await requestJson<Record<string, unknown>>(`${API}/bounties/${encodeURIComponent(id)}`, { headers: auth() });
      return pick(b, 'escrowId', 'bounty.escrowId') as string | undefined;
    }
    return undefined;
  }

  async function getBookingStatus(platformRef: string): Promise<PlatformBookingStatus> {
    const [kind, id, humanId] = platformRef.split(':');
    if (kind === 'escrow' && id) {
      const e = await requestJson<Record<string, unknown>>(`${API}/escrow/${encodeURIComponent(id)}`, { headers: auth() });
      const status = mapStatus(String(pick(e, 'status', 'escrow.status') ?? ''));
      const ev = evidenceText(e);
      return { status, deliveryText: ev.text, deliveryUrls: ev.urls };
    }
    if (kind === 'bounty' && id) {
      const b = await requestJson<Record<string, unknown>>(`${API}/bounties/${encodeURIComponent(id)}`, { headers: auth() });
      const apps = await requestJson<Record<string, unknown>>(`${API}/bounties/${encodeURIComponent(id)}/applications`, { headers: auth() }).catch(() => ({}));
      const list = (pick(apps, 'applications', 'data') ?? []) as Record<string, unknown>[];
      const mine = list.find((a) => String(a.humanId ?? '') === humanId);
      if (mine && String(mine.status ?? '') === 'pending') {
        // The chosen human applied: accept them (the booking was approved for this person).
        await requestJson(`${API}/bounties/${encodeURIComponent(id)}/applications/${encodeURIComponent(String(mine.id))}`, {
          method: 'PATCH',
          headers: auth(),
          json: { action: 'accept', response: 'Accepted by HAAS on behalf of the hirer.' },
        });
        return { status: 'in_progress' };
      }
      const ev = evidenceText(mine);
      const status = ev.text || ev.urls ? 'delivered' : mapStatus(String(pick(mine, 'status') ?? pick(b, 'status', 'bounty.status') ?? ''));
      return { status, deliveryText: ev.text, deliveryUrls: ev.urls };
    }
    throw new Error(`rentahuman: unknown booking reference ${platformRef}`);
  }

  async function acceptDelivery(platformRef: string): Promise<void> {
    const escrowId = await escrowIdOf(platformRef);
    if (!escrowId) throw new Error(`rentahuman: no escrow for ${platformRef}`);
    const path = `${API}/escrow/${encodeURIComponent(escrowId)}`;
    await requestJson(`${path}/complete`, { method: 'POST', headers: auth(), json: {} }).catch((err: unknown) => {
      // Already completed is fine; the release below is what pays.
      if (!(err instanceof HttpError && err.status === 409)) throw err;
    });
    await requestJson(`${path}/release`, { method: 'POST', headers: auth(), json: { acknowledgeRelease: true } });
  }

  return {
    name: 'rentahuman',
    platform: 'rentahuman',
    kind: 'api',
    isEnabled: () => true,
    search,
    getProfile,
    book,
    ...(config.RENTAHUMAN_API_KEY && config.RENTAHUMAN_BOOKING === 'live' ? { getBookingStatus, acceptDelivery } : {}),
  };
}
