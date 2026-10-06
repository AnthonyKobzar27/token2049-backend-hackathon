// First-party source: HAAS's own verified workers, booked through the bounty board.
// Search ranks workers by distance to the task; book() posts a bounty to the chosen worker
// (and, in broadcast mode, to nearby workers: first claim wins).

import type { BountyBoard } from '../bounty/board';
import { checkTask } from '../bounty/guard';
import { distanceKm } from '../bounty/places';
import { deriveSpec, rewardFor, rewardLabel, rulesSpec } from '../bounty/spec';
import type { Bounty, BountySpec } from '../bounty/types';
import type { Config } from '../config';
import type { EventBus, FreelancerSource, Store } from '../domain/ports';
import type { Brief, FreelancerProfile, PlatformBookingStatus, PlatformMessage } from '../domain/types';

export interface BountySourceDeps {
  board: BountyBoard;
  store: Store;
  config: Config;
  /** Injectable for tests; defaults to model-drafted with a rules fallback. */
  spec?: (brief: Brief) => Promise<BountySpec>;
}

const PHYSICAL: BountySpec['kind'][] = ['phone_call', 'on_site', 'errand'];
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

export function createBountySource(deps: BountySourceDeps): FreelancerSource {
  const { board, store, config } = deps;
  const specFor = deps.spec ?? ((brief: Brief) => deriveSpec(brief, config));
  const base = config.PUBLIC_URL.replace(/\/$/, '');

  function need(ref: string): Bounty {
    const b = board.get(ref);
    if (!b) throw new Error(`Bounty not found: ${ref}`);
    return b;
  }

  return {
    name: 'bounty',
    platform: 'bounty',
    kind: 'api',
    isEnabled: () => board.listWorkers().some((w) => w.verified),

    async search(brief, opts) {
      if (!checkTask(`${brief.task} ${brief.notes ?? ''}`).ok) return [];
      const spec = rulesSpec(brief);
      const want = new Set(words(`${brief.task} ${brief.skills.join(' ')}`));
      const reward = rewardFor(brief, spec.estMinutes);
      const point = spec.place?.point;
      return board
        .nearby(point)
        .filter(({ worker }) => PHYSICAL.includes(spec.kind) || worker.skills.some((s) => words(s).some((w) => want.has(w))))
        .slice(0, opts.limit)
        .map(({ worker: w, km }): FreelancerProfile => {
          const dist = km !== undefined ? `${km < 1 ? km.toFixed(1) : Math.round(km)} km from ${spec.place?.name ?? 'the task'}` : undefined;
          return {
            id: `bounty:${w.id}`,
            platform: 'bounty',
            platformId: w.id,
            url: `${base}/bounty/workers/${w.id}`,
            name: w.name,
            headline: `Verified HAAS worker in ${w.location.area ?? w.location.city}${dist ? `, ${dist}` : ''}`,
            description: `Takes short tasks such as calls and errands. Posted as: ${spec.title}`,
            skills: [...w.skills],
            category: 'microtask',
            country: w.location.country,
            city: w.location.city,
            ...(w.location.country === 'SG' && { timezone: 'Asia/Singapore' }),
            ...(w.languages && { languages: w.languages }),
            availability: { online: w.available, responseHours: 0.25 },
            pricing: [{ kind: 'fixed', amountUsd: reward.usd, original: { amount: reward.amount, currency: reward.currency }, label: `Bounty ${rewardLabel(reward)}`, deliveryDays: 0 }],
            ...(w.rating !== undefined && { rating: w.rating }),
            reviewCount: w.completed,
            level: 'HAAS verified',
            verified: w.verified,
            fetchedAt: Date.now(),
          };
        });
    },

    async getProfile(platformId) {
      const w = board.getWorker(platformId);
      if (!w) return null;
      return { id: `bounty:${w.id}`, platform: 'bounty', platformId: w.id, url: `${base}/bounty/workers/${w.id}`, name: w.name, headline: `Verified HAAS worker in ${w.location.city}`, skills: w.skills, country: w.location.country, city: w.location.city, pricing: [], rating: w.rating, reviewCount: w.completed, verified: w.verified, fetchedAt: Date.now() };
    },

    async book(req) {
      const verdict = checkTask(`${req.brief.task} ${req.brief.notes ?? ''}`);
      if (!verdict.ok) throw new Error(verdict.reason);
      const spec = await specFor(req.brief);
      const reward = rewardFor(req.brief, spec.estMinutes);
      const bounty = board.post({
        task: req.brief.task,
        spec,
        reward,
        rewardUsd: req.priceUsd > 0 ? req.priceUsd : reward.usd,
        bookingId: req.bookingId,
        jobId: store.getBooking(req.bookingId)?.jobId,
        workerId: req.profile.platform === 'bounty' ? req.profile.platformId : undefined,
      });
      return { kind: 'placed', platformRef: bounty.id, url: `${base}/bounty/${bounty.id}` };
    },

    async getBookingStatus(ref): Promise<PlatformBookingStatus> {
      const b = need(ref);
      switch (b.status) {
        case 'posted':
          return { status: 'placed' };
        case 'claimed':
          return { status: 'in_progress' };
        case 'submitted':
        case 'verified': {
          const r = b.result!;
          return {
            status: 'delivered',
            deliveryText: [r.summary, r.notes && `Notes: ${r.notes}`].filter(Boolean).join('\n'),
            deliveryData: { ...r.data, ...(r.notes && { notes: r.notes }), ...(r.photoUrl && { photo_url: r.photoUrl }) },
            deliverySummary: r.summary,
            ...(r.photoUrl && { deliveryUrls: [r.photoUrl] }),
          };
        }
        case 'paid':
          return { status: 'completed', ...(b.result && { deliveryText: b.result.summary, deliverySummary: b.result.summary, deliveryData: { ...b.result.data } }) };
        default:
          return { status: 'cancelled' };
      }
    },

    async sendMessage(ref, text) {
      if (!board.addMessage(need(ref).id, 'agent', text)) throw new Error(`Bounty not found: ${ref}`);
    },

    async readMessages(ref, since): Promise<PlatformMessage[]> {
      return need(ref)
        .messages.filter((m) => m.from === 'worker' && m.at > since)
        .map((m) => ({ externalId: m.id, fromFreelancer: true, text: m.text, at: m.at }));
    },

    async acceptDelivery(ref) {
      const res = await board.verifyAndPay(ref);
      if (!res.ok) throw new Error(res.error);
    },

    async requestRevision(ref, text) {
      const res = board.requestRevision(ref, text);
      if (!res.ok) throw new Error(res.error);
    },
  };
}

/** Mirrors booking cancellations onto the bounty (a submitted one counts as rejected). Returns unsubscribe. */
export function watchBountyBookings(deps: { bus: EventBus; board: BountyBoard }): () => void {
  return deps.bus.on((e) => {
    if (e.type !== 'booking.updated' || e.booking.platform !== 'bounty') return;
    if (e.booking.status !== 'cancelled' && e.booking.status !== 'refunded') return;
    for (const b of deps.board.list({ bookingId: e.booking.id, status: ['posted', 'claimed', 'submitted', 'verified'] })) {
      const reason = e.booking.note ?? 'booking cancelled';
      if (b.status === 'submitted') deps.board.reject(b.id, reason);
      else deps.board.cancel(b.id, reason);
    }
  });
}

/** Distance in km from a worker to a bounty's place, when both are known. */
export function workerDistanceKm(board: BountyBoard, workerId: string, bounty: Bounty): number | undefined {
  const w = board.getWorker(workerId);
  const p = bounty.spec.place?.point;
  return w && p ? distanceKm(p, w.location) : undefined;
}
