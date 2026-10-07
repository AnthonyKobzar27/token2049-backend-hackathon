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
import { HttpError, keywords, languageCode, requestJson, toUsd } from './http';

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

export function createRentAHumanSource(config: Config): FreelancerSource {
  const headers = (): Record<string, string> => (config.RENTAHUMAN_API_KEY ? { 'X-API-Key': config.RENTAHUMAN_API_KEY } : {});
  const maxLimit = config.RENTAHUMAN_API_KEY ? MAX_AUTH : MAX_UNAUTH;

  async function bySkill(skill: string, limit: number, signal?: AbortSignal, filters: Record<string, string | number> = {}): Promise<RawHuman[]> {
    const res = await requestJson<{ humans?: RawHuman[] }>(`${API}/humans`, {
      query: { skill, limit: Math.min(limit, maxLimit), ...filters },
      headers: headers(),
      signal,
    });
    return res.humans ?? [];
  }

  async function search(brief: Brief, opts: SearchOptions): Promise<FreelancerProfile[]> {
    const skills = (brief.skills.length ? brief.skills : keywords(brief.task, 3)).slice(0, 3);
    // Filters from the brief: hourly cap from budget and hours, and the place for on-site work.
    const filters: Record<string, string | number> = {};
    if (brief.budgetUsd && brief.budgetUsd > 0) filters.maxRate = Math.ceil(brief.budgetUsd / (brief.hoursNeeded && brief.hoursNeeded > 0 ? brief.hoursNeeded : 1));
    if (brief.location && !brief.remoteOk) filters.city = brief.location;
    const lists = await Promise.all(
      skills.map(async (skill) => {
        let found = await bySkill(skill, opts.limit, opts.signal, filters);
        // Too strict (city spelled differently, nobody under the cap): keep the skill, drop the filters.
        if (!found.length && Object.keys(filters).length) found = await bySkill(skill, opts.limit, opts.signal);
        if (found.length || !skill.includes(' ')) return found;
        // The skill filter is a substring match: retry a multi-word skill by its longest word.
        const word = skill.split(/\s+/).sort((a, b) => b.length - a.length)[0]!;
        return bySkill(word, opts.limit, opts.signal);
      }),
    );
    // Round-robin so every requested skill is represented before the limit cuts in.
    const seen = new Set<string>();
    const merged: RawHuman[] = [];
    for (let i = 0; merged.length < opts.limit && lists.some((l) => i < l.length); i++) {
      for (const list of lists) {
        const h = list[i];
        if (h && !seen.has(h.id) && merged.length < opts.limit) {
          seen.add(h.id);
          merged.push(h);
        }
      }
    }
    const now = Date.now();
    return merged.map((h) => normaliseHuman(h, now));
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
