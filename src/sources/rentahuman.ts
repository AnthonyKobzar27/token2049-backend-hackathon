// RentAHuman source. Search and profiles use the public REST API (no key needed). Booking is
// always a handoff: a bounty costs real money plus a fee, and the platform has no sandbox.

import type { Config } from '../config';
import type { FreelancerSource, SearchOptions } from '../domain/ports';
import type { BookingRequest, BookingResult, Brief, FreelancerProfile, Ms, Pricing } from '../domain/types';
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

  async function bySkill(skill: string, limit: number, signal?: AbortSignal): Promise<RawHuman[]> {
    const res = await requestJson<{ humans?: RawHuman[] }>(`${API}/humans`, {
      query: { skill, limit: Math.min(limit, maxLimit) },
      headers: headers(),
      signal,
    });
    return res.humans ?? [];
  }

  async function search(brief: Brief, opts: SearchOptions): Promise<FreelancerProfile[]> {
    const skills = (brief.skills.length ? brief.skills : keywords(brief.task, 3)).slice(0, 3);
    const lists = await Promise.all(
      skills.map(async (skill) => {
        const found = await bySkill(skill, opts.limit, opts.signal);
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

  async function book(request: BookingRequest): Promise<BookingResult> {
    const { profile } = request;
    return {
      kind: 'handoff',
      url: profile.url,
      instructions:
        `Open ${profile.name}'s RentAHuman profile and post a request (a bounty) for the task, then accept ${profile.name}'s application. ` +
        'Bounties are funded with real money plus a platform fee, so this agent does not create them automatically.',
    };
  }

  return {
    name: 'rentahuman',
    platform: 'rentahuman',
    kind: 'api',
    isEnabled: () => true,
    search,
    getProfile,
    book,
  };
}
