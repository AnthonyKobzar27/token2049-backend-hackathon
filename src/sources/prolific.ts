// Prolific source. Prolific is a pool of vetted research participants, not a directory of
// people, so search returns one synthetic candidate for the whole pool, priced for the brief:
// reward per participant plus Prolific's service fee, an estimated time to fill, and the size
// of the eligible pool. It only answers briefs that look like microtasks (surveys, labeling,
// user tests, short verification tasks) and can be done online.
//
// Booking creates an UNPUBLISHED draft study, which costs nothing. Publishing commits the
// rewards and fees, so it waits for a separate 'pay' approval through the approval gate; with
// no gate wired in, the draft stays a draft for the operator to publish by hand. Submissions
// are polled and exposed as the delivery; accepting the delivery approves them (which pays the
// participants) and happens only after the booking service's own 'accept' approval.
//
// API: https://api.prolific.com/api/v1, header "Authorization: Token <PROLIFIC_API_TOKEN>".
// A researcher account can create a token in the Prolific app; there is no separate review.

import { randomBytes } from 'node:crypto';
import type { Config } from '../config';
import type { ApprovalGate, FreelancerSource, SearchOptions, Store } from '../domain/ports';
import type { BookingRequest, BookingResult, Brief, FreelancerProfile, Ms, PlatformBookingStatus } from '../domain/types';
import { requestJson, round2, type RequestOptions } from './http';

const API = 'https://api.prolific.com/api/v1';
const APP = 'https://app.prolific.com';
/**
 * Prolific's service fee as a share of rewards. It has changed over time and depends on the
 * account, so this is a deliberately high estimate; the draft study shows the exact cost.
 */
export const FEE_RATE = 0.428;
export const POOL_ID = 'pool';

const MICROTASK = /\b(surveys?|questionnaires?|polls?|respondents?|participants?|label(?:l?ing|led|s)?|annotat\w*|classif\w*|user[- ]?test\w*|usability|ratings?|ranking|transcri\w*|verif\w*|data collection|microtasks?|crowdsourc\w*|opinions?|preference test\w*|a\/b test\w*)\b/i;

// ------------------------------------------------------------ raw shapes

export interface RawStudy {
  id: string;
  name?: string;
  status?: string;
  reward?: number;
  total_available_places?: number;
  places_taken?: number;
  number_of_submissions?: number;
  external_study_url?: string;
}

export interface RawSubmission {
  id: string;
  participant_id?: string;
  status?: string;
  started_at?: string;
  completed_at?: string | null;
  time_taken?: number | null;
  study_code?: string | null;
}

// ------------------------------------------------------------ planning

export interface StudyPlan {
  places: number;
  minutes: number;
  /** Per participant, in cents. */
  rewardCents: number;
  /** Rewards plus fee, USD. */
  totalUsd: number;
  /** Estimated days until every place is filled. */
  fillDays: number;
}

/** True when the brief reads like work a participant pool can do online. */
export function isMicrotask(brief: Brief): boolean {
  if (brief.remoteOk === false) return false;
  return MICROTASK.test([brief.task, brief.notes ?? '', ...brief.skills].join(' '));
}

const firstNumber = (text: string, re: RegExp): number | undefined => {
  const m = text.match(re);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Places, minutes and price for a brief. Fits places to `capUsd` (the budget, or the escrowed price). */
export function planStudy(brief: Brief, config: Config, capUsd: number | undefined = brief.budgetUsd): StudyPlan {
  const text = `${brief.task} ${brief.notes ?? ''}`;
  let places = firstNumber(text, /(\d{1,5})\s*(?:participants?|respondents?|people|responses|annotators|raters|testers|users)\b/i) ?? config.PROLIFIC_DEFAULT_PLACES;
  const minutes = Math.min(180, firstNumber(text, /(\d{1,3})\s*(?:-|\s)?(?:min|mins|minutes)\b/i) ?? config.PROLIFIC_DEFAULT_MINUTES);
  const rewardCents = Math.max(1, Math.ceil((minutes / 60) * config.PROLIFIC_HOURLY_REWARD_USD * 100));
  const each = (rewardCents / 100) * (1 + FEE_RATE);
  if (capUsd !== undefined && capUsd > 0 && places * each > capUsd + 0.01) places = Math.max(1, Math.floor(capUsd / each));
  const fillDays = places <= 50 ? 1 : places <= 300 ? 2 : 3;
  return { places, minutes, rewardCents, totalUsd: round2(places * each), fillDays };
}

/** Pure: the one candidate standing for the whole pool. */
export function poolProfile(brief: Brief, plan: StudyPlan, eligible: number | undefined, fetchedAt: Ms = Date.now()): FreelancerProfile {
  const rewardUsd = round2(plan.rewardCents / 100);
  const pool = eligible !== undefined ? `${eligible.toLocaleString('en-US')} eligible participants` : 'eligible pool size unknown';
  const filters: string[] = [];
  if (brief.location) filters.push(`location (${brief.location})`);
  if (brief.language) filters.push(`language (${brief.language})`);
  const filterNote = filters.length ? ` Not yet applied, set on the draft: ${filters.join(', ')}; this narrows the pool and can slow filling.` : '';
  return {
    id: `prolific:${POOL_ID}`,
    platform: 'prolific',
    platformId: POOL_ID,
    url: APP,
    name: 'Prolific participant pool',
    headline: `${plan.places} participants × ~${plan.minutes} min at $${rewardUsd} each, fee included in the total (${pool})`,
    description:
      `A Prolific study for microtasks: surveys, labeling, user tests and short verification tasks. ` +
      `Participants open your task link and return a completion code; answers stay in your own tool. ` +
      `Total is rewards plus an estimated ${Math.round(FEE_RATE * 100)}% service fee; time to fill (${plan.fillDays} day${plan.fillDays > 1 ? 's' : ''}) is an estimate.${filterNote}`,
    skills: ['surveys', 'data labeling', 'annotation', 'user testing', 'short verification tasks'],
    category: 'participant pool',
    availability: { online: true },
    pricing: [{ kind: 'fixed', amountUsd: plan.totalUsd, label: `${plan.places} × ${plan.minutes} min, incl. fee`, deliveryDays: plan.fillDays }],
    level: 'Participant pool',
    fetchedAt,
  };
}

/** First http(s) link in the brief, where the participants will do the task. */
export function taskUrl(brief: Brief, config: Config): string | undefined {
  const m = `${brief.notes ?? ''} ${brief.task}`.match(/https?:\/\/[^\s<>"')]+/i);
  return m?.[0] ?? config.PROLIFIC_TASK_URL;
}

/** Adds Prolific's URL parameters so the task tool can record who answered. */
export function withPlaceholders(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}`;
}

export const studyUrl = (id: string): string => `${APP}/researcher/workspaces/studies/${id}`;

/** Pure: Prolific study and submission states to our booking status, with the delivery. */
export function studyStatus(study: RawStudy, submissions: RawSubmission[]): PlatformBookingStatus {
  const s = (study.status ?? '').toUpperCase();
  const count = (st: string) => submissions.filter((x) => (x.status ?? '').toUpperCase() === st).length;
  const done = submissions.filter((x) => ['AWAITING REVIEW', 'APPROVED'].includes((x.status ?? '').toUpperCase()));
  if (s === 'UNPUBLISHED') return { status: 'placed' };
  if (s === 'AWAITING REVIEW' || s === 'COMPLETED' || (done.length > 0 && done.length >= (study.total_available_places ?? Infinity))) {
    const lines = [
      `Prolific: ${done.length} of ${study.total_available_places ?? '?'} places done ` +
        `(${count('APPROVED')} approved, ${count('AWAITING REVIEW')} awaiting review, ${count('RETURNED') + count('TIMED-OUT')} returned or timed out, ${count('REJECTED')} rejected).`,
      'Answers are in your task tool; match them by PROLIFIC_PID.',
      ...done.slice(0, 50).map((x) => `- ${x.participant_id ?? x.id}: ${x.status}${x.study_code ? `, code ${x.study_code}` : ''}${x.time_taken ? `, ${Math.round(x.time_taken / 60)} min` : ''}`),
    ];
    const urls = [studyUrl(study.id), ...(study.external_study_url ? [study.external_study_url.split('?')[0]!] : [])];
    return { status: 'delivered', deliveryText: lines.join('\n'), deliveryUrls: urls };
  }
  if (s === 'ACTIVE' || s === 'SCHEDULED' || s === 'PUBLISHING' || s === 'PAUSED') return { status: 'in_progress' };
  return { status: 'placed' };
}

// ---------------------------------------------------------------- source

interface StudyMeta {
  bookingId: string;
  jobId?: string;
  places: number;
  totalUsd: number;
  code: string;
  /** Set once the operator decided on publishing. */
  publish?: 'approved' | 'denied';
}

export interface ProlificDeps {
  config: Config;
  /** Keeps study metadata across restarts. */
  store?: Pick<Store, 'getKv' | 'setKv' | 'getBooking'>;
  /** Asked before publishing. Without it, drafts are never published automatically. */
  gate?: () => ApprovalGate | undefined;
}

export function createProlificSource(deps: ProlificDeps): FreelancerSource {
  const { config, store } = deps;
  const memory = new Map<string, StudyMeta>();
  const asking = new Set<string>();
  const metaKey = (id: string) => `prolific:study:${id}`;

  const getMeta = (id: string): StudyMeta | undefined => {
    const m = memory.get(id);
    if (m) return m;
    const raw = store?.getKv(metaKey(id));
    return raw ? (JSON.parse(raw) as StudyMeta) : undefined;
  };
  const setMeta = (id: string, meta: StudyMeta) => {
    memory.set(id, meta);
    store?.setKv(metaKey(id), JSON.stringify(meta));
  };

  const api = <T>(path: string, opts: RequestOptions = {}) =>
    requestJson<T>(`${API}${path}`, { ...opts, headers: { authorization: `Token ${config.PROLIFIC_API_TOKEN}`, ...opts.headers } });

  async function search(brief: Brief, opts: SearchOptions): Promise<FreelancerProfile[]> {
    if (opts.limit < 1 || !isMicrotask(brief)) return [];
    const plan = planStudy(brief, config);
    let eligible: number | undefined;
    try {
      const res = await api<{ count?: number }>('/eligibility-count/', { method: 'POST', json: { filters: [] }, signal: opts.signal, timeoutMs: config.PROLIFIC_TIMEOUT_MS });
      eligible = typeof res.count === 'number' ? res.count : undefined;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      // The pool size is a nice-to-have; the candidate stands without it.
    }
    return [poolProfile(brief, plan, eligible)];
  }

  async function book(request: BookingRequest): Promise<BookingResult> {
    const { brief, bookingId } = request;
    const link = taskUrl(brief, config);
    if (!link) {
      return {
        kind: 'handoff',
        url: `${APP}/researcher/workspaces`,
        instructions:
          'Prolific needs a link to the task (a survey, form or labeling tool) and the brief has none. ' +
          'Create the study in the Prolific app with that link, or add it to the brief and book again.',
      };
    }
    const plan = planStudy(brief, config, request.priceUsd);
    const code = randomBytes(4).toString('hex').toUpperCase();
    const body: Record<string, unknown> = {
      name: brief.task.slice(0, 120),
      internal_name: `haas:${bookingId}`,
      description: [brief.task, brief.notes].filter(Boolean).join('\n\n'),
      external_study_url: withPlaceholders(link),
      prolific_id_option: 'url_parameters',
      // Manual review: nobody is paid until the delivery is accepted.
      completion_codes: [{ code, code_type: 'COMPLETED', actions: [{ action: 'MANUALLY_REVIEW' }] }],
      estimated_completion_time: plan.minutes,
      maximum_allowed_time: Math.max(plan.minutes * 3, plan.minutes + 10),
      reward: plan.rewardCents,
      total_available_places: plan.places,
      device_compatibility: ['desktop', 'mobile', 'tablet'],
      filters: [],
    };
    if (config.PROLIFIC_PROJECT_ID) body.project = config.PROLIFIC_PROJECT_ID;
    const study = await api<RawStudy>('/studies/', { method: 'POST', json: body });
    const jobId = store?.getBooking(bookingId)?.jobId;
    setMeta(study.id, { bookingId, ...(jobId ? { jobId } : {}), places: plan.places, totalUsd: plan.totalUsd, code });
    return { kind: 'placed', platformRef: study.id, url: studyUrl(study.id) };
  }

  /** Asks once (per process) to publish a draft; publishes only on approval. */
  function askToPublish(id: string, meta: StudyMeta): void {
    const gate = deps.gate?.();
    if (!gate || meta.publish || asking.has(id)) return;
    asking.add(id);
    void gate
      .request({
        action: 'pay',
        bookingId: meta.bookingId,
        jobId: meta.jobId,
        summary: `Publish Prolific study for ${meta.places} participants (about $${meta.totalUsd} incl. fees)`,
        detail:
          `Draft: ${studyUrl(id)}\nPublishing commits the rewards and fees on Prolific. ` +
          `Your task must send participants to ${APP}/submissions/complete?cc=${meta.code} at the end (completion code ${meta.code}).`,
      })
      .then(async ({ approved }) => {
        if (approved) await api(`/studies/${id}/transition/`, { method: 'POST', json: { action: 'PUBLISH' } });
        setMeta(id, { ...meta, publish: approved ? 'approved' : 'denied' });
      })
      .catch((err) => console.error(`[prolific] publishing ${id} failed:`, err))
      .finally(() => asking.delete(id));
  }

  async function submissions(id: string): Promise<RawSubmission[]> {
    const out: RawSubmission[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await api<{ results?: RawSubmission[]; _links?: { next?: { href?: string | null } | null } }>('/submissions/', {
        query: { study: id, page, page_size: 100 },
      });
      out.push(...(res.results ?? []));
      if (!res._links?.next?.href) break;
    }
    return out;
  }

  async function getBookingStatus(platformRef: string): Promise<PlatformBookingStatus> {
    const study = await api<RawStudy>(`/studies/${platformRef}/`);
    if ((study.status ?? '').toUpperCase() === 'UNPUBLISHED') {
      const meta = getMeta(platformRef);
      if (meta) askToPublish(platformRef, meta);
      return { status: 'placed' };
    }
    return studyStatus(study, await submissions(platformRef));
  }

  async function acceptDelivery(platformRef: string): Promise<void> {
    for (const s of await submissions(platformRef)) {
      if ((s.status ?? '').toUpperCase() !== 'AWAITING REVIEW') continue;
      await api(`/submissions/${s.id}/transition/`, { method: 'POST', json: { action: 'APPROVE' } });
    }
  }

  async function requestRevision(): Promise<void> {
    throw new Error('Prolific has no revisions: ask participants to return a submission, or reject it, in the Prolific app.');
  }

  return {
    name: 'prolific',
    platform: 'prolific',
    kind: 'pool',
    timeoutMs: config.PROLIFIC_TIMEOUT_MS,
    isEnabled: () => !!config.PROLIFIC_API_TOKEN,
    search,
    book,
    getBookingStatus,
    acceptDelivery,
    requestRevision,
  };
}
