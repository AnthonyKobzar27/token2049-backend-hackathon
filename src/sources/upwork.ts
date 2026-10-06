// Upwork source, over the official GraphQL API (https://api.upwork.com/graphql).
//
// Access: an Upwork API key is issued only after Upwork reviews the application, and the
// client-credentials grant is offered to Enterprise accounts only. Everyone else runs the
// authorization-code flow once and puts the resulting token in UPWORK_ACCESS_TOKEN.
// Search uses `freelancerProfileSearchRecords`; the top results are enriched with
// `freelancerProfileByProfileKey` for Job Success Score, availability and time zone.
// The schema was taken from Upwork's published GraphQL schema; live calls are untested here.
//
// Booking is always a handoff: hiring on Upwork means an offer funded by the client's card,
// so a person sends it on upwork.com.

import type { Config } from '../config';
import type { FreelancerSource, SearchOptions } from '../domain/ports';
import type { BookingRequest, BookingResult, Brief, FreelancerProfile, Ms, Pricing } from '../domain/types';
import { findCountry, HttpError, keywords, requestJson, round2, toUsd } from './http';

const GRAPHQL = 'https://api.upwork.com/graphql';
const TOKEN_URL = 'https://www.upwork.com/api/v3/oauth2/token';
const SITE = 'https://www.upwork.com';
/** Profiles enriched with a second query per search. */
const ENRICH = 5;

// ------------------------------------------------------------ raw shapes

interface Money {
  rawValue?: string | null;
  currency?: string | null;
}

/** `FreelancerProfilesSearchRecord` */
export interface RawSearchRecord {
  id?: string | null;
  title?: string | null;
  description?: string | null;
  shortName?: string | null;
  ciphertext?: string | null;
  lastActiveDateTime?: string | null;
  totalHourlyJobs?: number | null;
  totalFixedPriceJobs?: number | null;
  skills?: { preferredLabel?: string | null }[] | null;
  hourlyRate?: Money | null;
  topRatedStatus?: string | null;
  avgFeedbackScore?: number | null;
  location?: { country?: string | null; city?: string | null; state?: string | null } | null;
}

/** The subset of `FreelancerProfile` we ask for. */
export interface RawFullProfile {
  personalData?: {
    title?: string | null;
    description?: string | null;
    chargeRate?: Money | null;
    profileUrl?: string | null;
    address?: { countryName?: string | null; cityName?: string | null; timezone?: string | null } | null;
  } | null;
  aggregates?: {
    jobSuccessScore?: number | null;
    topRatedStatus?: string | null;
    topRatedPlusStatus?: string | null;
    totalFeedback?: number | null;
    adjustedFeedbackScore?: number | null;
  } | null;
  availability?: { name?: string | null; availabilityDateTime?: string | null } | null;
  committedResponseTime?: { name?: string | null } | null;
  verifications?: { idVerified?: boolean | null } | null;
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: { message?: string }[];
}

export const SEARCH_QUERY = `
query HaasTalentSearch($searchFilter: FreelancerProfileSearchFilter!, $pagination: Pagination!) {
  freelancerProfileSearchRecords(searchFilter: $searchFilter, pagination: $pagination) {
    edges {
      node {
        ... on FreelancerProfilesSearchRecord {
          id title description shortName ciphertext lastActiveDateTime
          totalHourlyJobs totalFixedPriceJobs topRatedStatus avgFeedbackScore
          skills { preferredLabel }
          hourlyRate { rawValue currency }
          location { country city state }
        }
      }
    }
    totalCount
  }
}`;

export const PROFILE_QUERY = `
query HaasTalentProfile($profileKey: String!) {
  freelancerProfileByProfileKey(profileKey: $profileKey) {
    personalData {
      title description profileUrl
      chargeRate { rawValue currency }
      address { countryName cityName timezone }
    }
    aggregates { jobSuccessScore topRatedStatus topRatedPlusStatus totalFeedback adjustedFeedbackScore }
    availability { name availabilityDateTime }
    committedResponseTime { name }
    verifications { idVerified }
  }
}`;

// ------------------------------------------------------------ normalise

function hourly(money: Money | null | undefined): Pricing[] {
  const amount = Number(money?.rawValue);
  if (!Number.isFinite(amount) || amount <= 0) return [];
  const code = (money?.currency || 'USD').toUpperCase();
  const usd = toUsd(amount, code);
  if (usd === undefined) return [];
  return [{ kind: 'hourly', amountUsd: round2(usd), ...(code !== 'USD' ? { original: { amount, currency: code } } : {}) }];
}

function countryCode(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  if (/^[A-Z]{2}$/.test(name)) return name;
  return findCountry(name)?.code ?? name;
}

function level(topRated?: string | null, topRatedPlus?: string | null): string | undefined {
  const plus = (topRatedPlus ?? '').toLowerCase();
  if (plus && plus !== 'none' && plus !== 'not_eligible') return 'Top Rated Plus';
  const s = (topRated ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  if (s === 'top_rated_plus') return 'Top Rated Plus';
  if (s === 'top_rated') return 'Top Rated';
  if (s === 'rising_talent') return 'Rising Talent';
  return undefined;
}

/** "Immediate (30 min)" -> 0.5, "Soon (12 hours)" -> 12. */
function responseHours(name: string | null | undefined): number | undefined {
  const m = name?.match(/(\d+(?:\.\d+)?)\s*(min|hour|hr|h)/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2]!.toLowerCase().startsWith('min') ? round2(n / 60) : n;
}

/** Upwork's capacity names: "More than 30 hrs/week", "Less than 30 hrs/week", "As needed - open to offers". */
function hoursPerWeek(name: string | null | undefined): number | undefined {
  if (!name) return undefined;
  if (/more than 30/i.test(name)) return 40;
  if (/less than 30/i.test(name)) return 20;
  if (/as needed/i.test(name)) return 10;
  return undefined;
}

const profileUrl = (key: string): string => `${SITE}/freelancers/${key.startsWith('~') ? key : `~${key}`}`;

/** Pure: one search record to our profile. Fields Upwork does not return stay undefined. */
export function normaliseRecord(r: RawSearchRecord, fetchedAt: Ms = Date.now()): FreelancerProfile {
  const key = r.ciphertext || r.id || 'unknown';
  const skills = (r.skills ?? []).map((s) => s.preferredLabel?.trim()).filter((s): s is string => !!s);
  const rating = r.avgFeedbackScore && r.avgFeedbackScore > 0 ? round2(Math.min(5, r.avgFeedbackScore)) : undefined;
  return {
    id: `upwork:${key}`,
    platform: 'upwork',
    platformId: key,
    url: profileUrl(key),
    name: r.shortName?.trim() || `Upwork freelancer ${key.slice(-6)}`,
    headline: r.title?.trim() ?? '',
    description: r.description?.trim() || undefined,
    skills,
    country: countryCode(r.location?.country),
    city: r.location?.city || undefined,
    pricing: hourly(r.hourlyRate),
    rating,
    // The search record has no review count; enrichProfile fills it from the full profile.
    reviewCount: undefined,
    level: level(r.topRatedStatus),
    fetchedAt,
  };
}

/** Pure: adds what the full profile knows (Job Success Score, availability, time zone). */
export function enrichProfile(p: FreelancerProfile, full: RawFullProfile): FreelancerProfile {
  const pd = full.personalData ?? {};
  const ag = full.aggregates ?? {};
  const out: FreelancerProfile = { ...p };
  if (!out.pricing.length) out.pricing = hourly(pd.chargeRate);
  if (!out.headline && pd.title) out.headline = pd.title.trim();
  if (!out.description && pd.description) out.description = pd.description.trim();
  if (pd.profileUrl) out.url = pd.profileUrl;
  if (!out.country) out.country = countryCode(pd.address?.countryName);
  if (!out.city && pd.address?.cityName) out.city = pd.address.cityName;
  if (pd.address?.timezone && /\//.test(pd.address.timezone)) out.timezone = pd.address.timezone;
  if (ag.totalFeedback !== undefined && ag.totalFeedback !== null) out.reviewCount = ag.totalFeedback;
  if (out.rating === undefined && ag.adjustedFeedbackScore && ag.adjustedFeedbackScore > 0) out.rating = round2(Math.min(5, ag.adjustedFeedbackScore));
  const lvl = level(ag.topRatedStatus, ag.topRatedPlusStatus);
  if (lvl) out.level = lvl;
  if (ag.jobSuccessScore !== undefined && ag.jobSuccessScore !== null) {
    out.level = [out.level, `${Math.round(ag.jobSuccessScore)}% Job Success`].filter(Boolean).join(', ');
  }
  const hpw = hoursPerWeek(full.availability?.name);
  const rh = responseHours(full.committedResponseTime?.name);
  if (hpw !== undefined || rh !== undefined) out.availability = { ...out.availability, ...(hpw !== undefined ? { hoursPerWeek: hpw } : {}), ...(rh !== undefined ? { responseHours: rh } : {}) };
  if (full.verifications?.idVerified !== undefined && full.verifications.idVerified !== null) out.verified = full.verifications.idVerified;
  return out;
}

/** Search filter for a brief: keyword from skills or task, country when the work is on site. */
export function searchFilter(brief: Brief): Record<string, unknown> {
  const words = brief.skills.length ? brief.skills.slice(0, 3) : keywords(brief.task, 4);
  const filter: Record<string, unknown> = { userType: 'FREELANCER', keyword: words.join(' ') || brief.task.slice(0, 60) };
  const country = brief.location ? findCountry(brief.location) : undefined;
  if (country && brief.remoteOk === false) filter.location = { country: country.code };
  return filter;
}

// ---------------------------------------------------------------- source

export function createUpworkSource(config: Config): FreelancerSource {
  let cached: { token: string; expires: Ms } | undefined;

  async function token(signal?: AbortSignal): Promise<string> {
    if (config.UPWORK_ACCESS_TOKEN) return config.UPWORK_ACCESS_TOKEN;
    if (cached && cached.expires > Date.now()) return cached.token;
    const res = await requestJson<{ access_token?: string; expires_in?: number }>(TOKEN_URL, {
      method: 'POST',
      form: { grant_type: 'client_credentials', client_id: config.UPWORK_CLIENT_ID, client_secret: config.UPWORK_CLIENT_SECRET },
      signal,
    });
    if (!res.access_token) throw new Error('upwork: token response had no access_token');
    cached = { token: res.access_token, expires: Date.now() + Math.max(60, (res.expires_in ?? 3600) - 60) * 1000 };
    return cached.token;
  }

  async function gql<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${await token(signal)}` };
    if (config.UPWORK_TENANT_ID) headers['X-Upwork-API-TenantId'] = config.UPWORK_TENANT_ID;
    let res: GraphQLResponse<T>;
    try {
      res = await requestJson<GraphQLResponse<T>>(GRAPHQL, { method: 'POST', headers, json: { query, variables }, signal, timeoutMs: config.UPWORK_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) cached = undefined;
      throw err;
    }
    if (!res.data) throw new Error(`upwork: ${res.errors?.map((e) => e.message).join('; ') || 'empty response'}`);
    return res.data;
  }

  async function fullProfile(key: string, signal?: AbortSignal): Promise<RawFullProfile | null> {
    const data = await gql<{ freelancerProfileByProfileKey?: RawFullProfile | null }>(PROFILE_QUERY, { profileKey: key }, signal);
    return data.freelancerProfileByProfileKey ?? null;
  }

  async function search(brief: Brief, opts: SearchOptions): Promise<FreelancerProfile[]> {
    const data = await gql<{ freelancerProfileSearchRecords?: { edges?: { node?: RawSearchRecord | null }[] } | null }>(
      SEARCH_QUERY,
      { searchFilter: searchFilter(brief), pagination: { first: Math.min(Math.max(1, opts.limit), 50) } },
      opts.signal,
    );
    const now = Date.now();
    const base = (data.freelancerProfileSearchRecords?.edges ?? [])
      .map((e) => e.node)
      .filter((n): n is RawSearchRecord => !!n && !!(n.ciphertext || n.id))
      .slice(0, opts.limit)
      .map((r) => normaliseRecord(r, now));
    // Enrichment is best effort: a failure keeps the search record as it is.
    const enriched = await Promise.all(
      base.slice(0, ENRICH).map(async (p) => {
        try {
          const full = await fullProfile(p.platformId, opts.signal);
          return full ? enrichProfile(p, full) : p;
        } catch {
          return p;
        }
      }),
    );
    return [...enriched, ...base.slice(ENRICH)];
  }

  async function getProfile(platformId: string): Promise<FreelancerProfile | null> {
    const full = await fullProfile(platformId);
    if (!full) return null;
    const base = normaliseRecord({ ciphertext: platformId, title: full.personalData?.title }, Date.now());
    return enrichProfile(base, full);
  }

  async function book(request: BookingRequest): Promise<BookingResult> {
    const { profile, brief } = request;
    const hours = brief.hoursNeeded ? ` for about ${brief.hoursNeeded} hours` : '';
    return {
      kind: 'handoff',
      url: profile.url,
      instructions:
        `Open ${profile.name}'s Upwork profile, choose "Hire" (or invite them to a job post) and send an offer${hours} within $${request.priceUsd}. ` +
        'Upwork offers are funded from the client account, so HAAS does not send them; hiring and paying stay on upwork.com.',
    };
  }

  return {
    name: 'upwork',
    platform: 'upwork',
    kind: 'api',
    timeoutMs: config.UPWORK_TIMEOUT_MS,
    isEnabled: () => !!config.UPWORK_ACCESS_TOKEN || (!!config.UPWORK_CLIENT_ID && !!config.UPWORK_CLIENT_SECRET),
    search,
    getProfile,
    book,
  };
}
