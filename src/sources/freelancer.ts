// Freelancer.com source. Search and profiles use the public production API (the user directory
// answers without a token). Every write goes to the sandbox host only; this build never spends
// real money on Freelancer.

import type { Config } from '../config';
import type { FreelancerSource, SearchOptions } from '../domain/ports';
import type {
  BookingRequest,
  BookingResult,
  Brief,
  FreelancerProfile,
  Ms,
  PlatformBookingStatus,
  PlatformMessage,
  Pricing,
} from '../domain/types';
import { findCountry, HttpError, keywords, requestJson, round2, toUsd, type Query } from './http';

const PROD = 'https://www.freelancer.com/api';
const SANDBOX = 'https://www.freelancer-sandbox.com/api';
const PROD_SITE = 'https://www.freelancer.com';
const SANDBOX_SITE = 'https://www.freelancer-sandbox.com';
/** Job id every Hire Me project must carry (SDK: create_hireme_project). */
const HIREME_JOB_ID = 417;
const USD_CURRENCY_ID = 1;

// ------------------------------------------------------------ raw shapes

interface RawJob {
  id: number;
  name: string;
  category?: { id?: number; name?: string } | null;
}

export interface RawUser {
  id: number;
  username?: string;
  display_name?: string | null;
  public_name?: string | null;
  company?: string | null;
  tagline?: string | null;
  profile_description?: string | null;
  hourly_rate?: number | null;
  closed?: boolean;
  location?: { country?: { name?: string; code?: string } | null; city?: string | null } | null;
  timezone?: { timezone?: string } | null;
  primary_currency?: { code?: string; exchange_rate?: number } | null;
  status?: { identity_verified?: boolean; payment_verified?: boolean } | null;
  jobs?: RawJob[] | null;
  reputation?: { entire_history?: { overall?: number | null; reviews?: number | null } | null } | null;
  qualifications?: { name?: string }[] | null;
  preferred_freelancer?: boolean | null;
  freelancer_verified_status?: unknown;
}

interface Envelope<T> {
  status: string;
  result: T;
  message?: string;
}

// Projections the directory and user endpoints need to return our fields.
const DETAILS = {
  compact: true,
  reputation: true,
  profile_description: true,
  jobs: true,
  status: true,
  country_details: true,
  location_details: true,
  timezone_details: true,
  qualification_details: true,
  display_info: true,
};

// ----------------------------------------------------------- normaliser

/** Pure: one Freelancer user object to our profile. */
export function normaliseUser(u: RawUser, fetchedAt: Ms = Date.now()): FreelancerProfile {
  const id = String(u.id);
  const name = u.display_name || u.public_name || u.username || `User ${id}`;
  const description = u.profile_description?.trim() || undefined;
  const headline = u.tagline?.trim() || (description ? firstSentence(description) : '') || u.company?.trim() || '';

  const pricing: Pricing[] = [];
  if (u.hourly_rate && u.hourly_rate > 0) {
    const code = (u.primary_currency?.code ?? 'USD').toUpperCase();
    const usd = toUsd(u.hourly_rate, code, u.primary_currency?.exchange_rate);
    if (usd !== undefined) {
      pricing.push({
        kind: 'hourly',
        amountUsd: usd,
        ...(code !== 'USD' ? { original: { amount: u.hourly_rate, currency: code } } : {}),
      });
    }
  }

  const rep = u.reputation?.entire_history;
  const reviews = rep?.reviews ?? undefined;
  const rating = reviews && reviews > 0 && typeof rep?.overall === 'number' ? round2(Math.min(5, rep.overall)) : undefined;

  const skills = (u.jobs ?? []).map((j) => j.name);
  const countryCode = u.location?.country?.code?.toUpperCase();
  const verified = u.status?.identity_verified;

  return {
    id: `freelancer:${id}`,
    platform: 'freelancer',
    platformId: id,
    url: `${PROD_SITE}/u/${u.username ?? id}`,
    name,
    headline,
    description,
    skills,
    category: topCategory(u.jobs ?? []),
    country: countryCode || u.location?.country?.name || undefined,
    city: u.location?.city || undefined,
    timezone: u.timezone?.timezone || undefined,
    pricing,
    rating,
    reviewCount: reviews ?? undefined,
    level: u.preferred_freelancer ? 'Preferred Freelancer' : undefined,
    verified: typeof verified === 'boolean' ? verified : undefined,
    fetchedAt,
  };
}

function firstSentence(text: string): string {
  const line = text.split(/\n/)[0] ?? '';
  const s = line.split(/(?<=[.!?])\s/)[0] ?? line;
  return s.length > 140 ? `${s.slice(0, 137)}...` : s;
}

function topCategory(jobs: RawJob[]): string | undefined {
  const counts = new Map<string, number>();
  for (const j of jobs) if (j.category?.name) counts.set(j.category.name, (counts.get(j.category.name) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

// --------------------------------------------------------------- source

export function createFreelancerSource(config: Config): FreelancerSource {
  const token = config.FREELANCER_TOKEN;
  const sandboxToken = config.FREELANCER_SANDBOX_TOKEN;

  const prodHeaders = (): Record<string, string> => (token ? { 'freelancer-oauth-v1': token } : {});

  /** Sandbox call; throws when no sandbox token is configured. */
  async function sandbox<T>(
    path: string,
    opts: { method?: 'GET' | 'POST' | 'PUT'; query?: Query; json?: unknown; form?: Query } = {},
  ): Promise<T> {
    if (!sandboxToken) throw new Error('FREELANCER_SANDBOX_TOKEN is not set');
    const res = await requestJson<Envelope<T>>(`${SANDBOX}${path}`, {
      ...opts,
      headers: { 'freelancer-oauth-v1': sandboxToken },
    });
    return res.result;
  }

  /** Job ids for skill names, from the public jobs endpoint. */
  async function resolveJobIds(names: string[], signal?: AbortSignal): Promise<number[]> {
    const found = await Promise.all(
      names.map(async (name) => {
        try {
          const res = await requestJson<Envelope<RawJob[]>>(`${PROD}/projects/0.1/jobs/search/`, {
            query: { 'job_names[]': name, limit: 5 },
            headers: prodHeaders(),
            signal,
          });
          const list = res.result ?? [];
          return (list.find((j) => j.name.toLowerCase() === name.toLowerCase()) ?? list[0])?.id;
        } catch {
          return undefined;
        }
      }),
    );
    return [...new Set(found.filter((n): n is number => n !== undefined))];
  }

  async function search(brief: Brief, opts: SearchOptions): Promise<FreelancerProfile[]> {
    const names = (brief.skills.length ? brief.skills : keywords(brief.task, 3)).slice(0, 3);
    const jobIds = await resolveJobIds(names, opts.signal);
    const query: Query = {
      ...DETAILS,
      limit: opts.limit,
    };
    if (jobIds.length) query['jobs[]'] = jobIds;
    else query.query = names.join(' ');
    // Country filter only for on-site work; for remote work location is a preference, not a requirement.
    if (!brief.remoteOk && brief.location) {
      const country = findCountry(brief.location);
      if (country) query['countries[]'] = [country.name];
    }
    const res = await requestJson<Envelope<{ users: RawUser[] }>>(`${PROD}/users/0.1/users/directory/`, {
      query,
      headers: prodHeaders(),
      signal: opts.signal,
    });
    const now = Date.now();
    return (res.result?.users ?? []).filter((u) => !u.closed).slice(0, opts.limit).map((u) => normaliseUser(u, now));
  }

  async function getProfile(platformId: string): Promise<FreelancerProfile | null> {
    try {
      const res = await requestJson<Envelope<RawUser>>(`${PROD}/users/0.1/users/${encodeURIComponent(platformId)}/`, {
        query: DETAILS,
        headers: prodHeaders(),
      });
      return res.result ? normaliseUser(res.result) : null;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
  }

  // ----------------------------------------------------- sandbox writes

  let selfId: number | undefined;
  async function self(): Promise<number> {
    selfId ??= (await sandbox<{ id: number }>('/users/0.1/self/')).id;
    return selfId;
  }

  const handoff = (profile: FreelancerProfile, why: string): BookingResult => ({
    kind: 'handoff',
    url: profile.url,
    instructions: `${why} Open the profile and use "Hire Me" to start a fixed-price project with ${profile.name}, using the brief as the description.`,
  });

  async function book(request: BookingRequest): Promise<BookingResult> {
    const { profile, brief, priceUsd } = request;
    if (!sandboxToken) return handoff(profile, 'No Freelancer sandbox credentials are configured, so nothing was booked automatically.');
    try {
      // Sandbox user ids differ from production; without the same id there is nobody to hire.
      try {
        await sandbox(`/users/0.1/users/${encodeURIComponent(profile.platformId)}/`, { query: { compact: true } });
      } catch (err) {
        if (err instanceof HttpError && (err.status === 404 || err.status === 400)) {
          return handoff(profile, `This freelancer (id ${profile.platformId}) does not exist in the Freelancer sandbox, so the sandbox booking was skipped.`);
        }
        throw err;
      }
      const skillNames = brief.skills.length ? brief.skills : profile.skills.slice(0, 2);
      const jobIds = await resolveJobIds(skillNames.slice(0, 3));
      if (!jobIds.length) return handoff(profile, 'No matching Freelancer skill id was found for the brief.');
      const amount = round2(priceUsd);
      const title = `Hire Me: ${brief.task}`.slice(0, 100);
      const description = [
        brief.task,
        brief.notes,
        brief.skills.length ? `Skills: ${brief.skills.join(', ')}` : undefined,
        brief.deadlineDays ? `Deadline: ${brief.deadlineDays} days` : undefined,
        `Budget: ${amount} USD fixed price.`,
      ]
        .filter(Boolean)
        .join('\n');
      const project = await sandbox<{ id: number; seo_url?: string }>('/projects/0.1/projects/', {
        method: 'POST',
        json: {
          title,
          description,
          currency: { id: USD_CURRENCY_ID },
          budget: { minimum: amount, maximum: amount },
          jobs: [...jobIds.map((id) => ({ id })), { id: HIREME_JOB_ID }],
          hireme: true,
          hireme_initial_bid: { bidder_id: Number(profile.platformId), amount, period: brief.deadlineDays ?? 7 },
        },
      });
      return {
        kind: 'placed',
        platformRef: String(project.id),
        url: `${SANDBOX_SITE}/projects/${project.seo_url ?? project.id}`,
      };
    } catch (err) {
      return handoff(profile, `The sandbox booking failed (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  interface RawMilestone {
    id: number;
    status: string;
    amount: number;
  }

  async function milestones(projectId: string): Promise<RawMilestone[]> {
    const r = await sandbox<{ milestones?: RawMilestone[] }>('/projects/0.1/milestones/', { query: { 'projects[]': [projectId] } });
    return r.milestones ?? [];
  }

  async function messagesOf(projectId: string): Promise<{ id: number; from_user: number; message: string; time_created: number }[]> {
    const r = await sandbox<{ messages?: { id: number; from_user: number; message: string; time_created: number }[] }>('/messages/0.1/messages/', {
      query: { 'contexts[]': [projectId], context_type: 'project', limit: 50 },
    });
    return r.messages ?? [];
  }

  async function getBookingStatus(platformRef: string): Promise<PlatformBookingStatus> {
    const [project, ms] = await Promise.all([
      sandbox<{ status?: string }>(`/projects/0.1/projects/${platformRef}/`),
      milestones(platformRef),
    ]);
    const live = ms.filter((m) => m.status !== 'canceled');
    if (live.some((m) => m.status === 'cleared')) return { status: 'completed' };
    if (live.some((m) => m.status === 'requested_release')) {
      const me = await self();
      const last = (await messagesOf(platformRef)).filter((m) => m.from_user !== me).sort((a, b) => b.time_created - a.time_created)[0];
      return { status: 'delivered', deliveryText: last?.message };
    }
    if (live.length) return { status: 'in_progress' };
    if (ms.length || project.status === 'closed') return { status: 'cancelled' };
    return { status: 'placed' };
  }

  /** The freelancer hired on this project: the bidder of its (initial) bid. */
  async function freelancerOf(projectId: string): Promise<number> {
    const r = await sandbox<{ bids?: { bidder_id: number }[] }>('/projects/0.1/bids/', { query: { 'projects[]': [projectId] } });
    const bidder = r.bids?.[0]?.bidder_id;
    if (!bidder) throw new Error(`no bid on project ${projectId}`);
    return bidder;
  }

  async function sendMessage(platformRef: string, text: string): Promise<void> {
    const threads = await sandbox<{ threads?: { id: number }[] }>('/messages/0.1/threads/', {
      query: { context_type: 'project', 'contexts[]': [platformRef] },
    });
    const existing = threads.threads?.[0]?.id;
    if (existing) {
      await sandbox(`/messages/0.1/threads/${existing}/messages/`, { method: 'POST', form: { message: text } });
      return;
    }
    const members = [await self(), await freelancerOf(platformRef)];
    await sandbox('/messages/0.1/threads/', {
      method: 'POST',
      form: { 'members[]': members, context_type: 'project', context: platformRef, message: text },
    });
  }

  async function readMessages(platformRef: string, since: number): Promise<PlatformMessage[]> {
    const me = await self();
    return (await messagesOf(platformRef))
      .map((m) => ({
        externalId: String(m.id),
        fromFreelancer: m.from_user !== me,
        text: m.message,
        // Platform times are epoch seconds.
        at: m.time_created < 1e12 ? m.time_created * 1000 : m.time_created,
      }))
      .filter((m) => m.at > since)
      .sort((a, b) => a.at - b.at);
  }

  async function acceptDelivery(platformRef: string): Promise<void> {
    const ms = (await milestones(platformRef)).filter((m) => m.status === 'requested_release' || m.status === 'frozen');
    const target = ms.find((m) => m.status === 'requested_release') ?? ms[0];
    if (!target) throw new Error(`no releasable milestone on project ${platformRef}`);
    await sandbox(`/projects/0.1/milestones/${target.id}/`, { method: 'PUT', query: { action: 'release' }, json: { amount: target.amount } });
  }

  async function requestRevision(platformRef: string, text: string): Promise<void> {
    await sendMessage(platformRef, `Revision requested: ${text}`);
  }

  return {
    name: 'freelancer',
    platform: 'freelancer',
    kind: 'api',
    // The directory answers without a token, so search needs no credentials.
    isEnabled: () => true,
    search,
    getProfile,
    book,
    getBookingStatus,
    sendMessage,
    readMessages,
    acceptDelivery,
    requestRevision,
  };
}
