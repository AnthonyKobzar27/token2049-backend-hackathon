import type { Config } from '../config';
import type { Delegator } from '../delegate/delegate';
import { assertJobTransition } from '../domain/machine';
import { newId, now } from '../domain/ids';
import type { BookingService, EventBus, JobService, Router, Store } from '../domain/ports';
import type { Booking, Brief, Candidate, Job, JobResult, JobStatus, UserInput } from '../domain/types';
import { resultPayload } from '../verify/hash';

/**
 * The verified result the escrow release was bound to. `hash` is the MIP-004 hash of `payload`
 * (sha256 of "<identifierFromPurchaser>;<payload>"), so a buyer can check it, and the Masumi
 * watcher submits this same hash instead of hashing the whole /status result.
 */
export function verifiedResultOf(booking: Booking): NonNullable<JobResult['verifiedResult']> {
  const d = booking.delivery;
  return { hash: booking.resultHash!, payload: resultPayload(booking.id, { text: d?.text, urls: d?.urls, fields: d?.data }) };
}

export interface JobDeps {
  store: Store;
  bus: EventBus;
  router: Router;
  bookings: BookingService;
  config: Config;
  /** Optional AI-first step: tried once per job before the human router. */
  delegate?: Delegator;
}

const excludeKey = (jobId: string) => `job:${jobId}:exclude`;
const feedbackKey = (jobId: string) => `job:${jobId}:feedback`;
const aiTriedKey = (jobId: string) => `job:${jobId}:ai_tried`;
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createJobService(deps: JobDeps): JobService {
  const { store, bus, router, bookings, config } = deps;
  /** Jobs with routing in flight, so the same job is never routed twice at once. */
  const routing = new Set<string>();

  function move(id: string, to: JobStatus, patch: Partial<Job> = {}): Job {
    const cur = store.getJob(id);
    if (!cur) throw new Error(`Job not found: ${id}`);
    assertJobTransition(cur.status, to);
    const job = store.updateJob(id, { ...patch, status: to });
    bus.emit({ type: 'job.updated', job });
    return job;
  }

  const readList = (key: string): string[] => {
    try {
      return JSON.parse(store.getKv(key) ?? '[]') as string[];
    } catch {
      return [];
    }
  };

  async function route(jobId: string): Promise<void> {
    if (routing.has(jobId)) return;
    routing.add(jobId);
    try {
      const job = store.getJob(jobId);
      if (!job || job.status !== 'running') return;
      // Marked before hiring: after a restart mid-hire the job goes to the human router instead of
      // hiring (and possibly paying) a second agent for the same work.
      if (deps.delegate && !job.path && store.getKv(aiTriedKey(jobId))) store.updateJob(jobId, { path: 'human' });
      else if (deps.delegate && !job.path) {
        store.setKv(aiTriedKey(jobId), String(now()));
        const ai = await deps.delegate.tryAi(job);
        const cur = store.getJob(jobId);
        if (!cur || cur.status !== 'running') return;
        if (ai.result) {
          // complete() also carries an x402 settlement into the result, as on the human path.
          complete(store.updateJob(jobId, { path: 'ai' }), ai.result);
          return;
        }
        store.updateJob(jobId, { path: 'human' });
      }
      const exclude = readList(excludeKey(jobId));
      const feedback = store.getKv(feedbackKey(jobId)) ?? undefined;
      const { candidates, sources } = await router.route(job.brief, { jobId, limit: config.SHORTLIST_SIZE, exclude, feedback });
      const fresh = store.getJob(jobId);
      if (!fresh || fresh.status !== 'running') return;
      const shortlist = { id: newId('sl'), jobId, round: fresh.round, candidates, sources, createdAt: now() };
      store.insertShortlist(shortlist);
      const updated = move(jobId, 'awaiting_input', { shortlistId: shortlist.id });
      bus.emit({ type: 'shortlist.ready', job: updated, shortlist });
    } catch (err) {
      try {
        const cur = store.getJob(jobId);
        if (cur && cur.status === 'running') move(jobId, 'failed', { error: errMsg(err) });
      } catch (inner) {
        console.error(`[jobs] could not fail job ${jobId}:`, inner);
      }
    } finally {
      routing.delete(jobId);
    }
  }

  const routeInBackground = (jobId: string) => void route(jobId);

  function complete(job: Job, result: JobResult): Job {
    const base = { path: job.path ?? 'human', ...result };
    return move(job.id, 'completed', { result: job.settlement ? { ...base, settlement: job.settlement } : base });
  }

  function candidateFor(job: Job, profileId: string): Candidate | undefined {
    const sl = (job.shortlistId && store.getShortlist(job.shortlistId)) || store.latestShortlist(job.id);
    return sl?.candidates.find((c) => c.profile.id === profileId);
  }

  /** Completes a running job whose booking has reached a state that ends it. */
  function settle(job: Job, booking: Booking): Job | null {
    if (job.status !== 'running' || job.bookingId !== booking.id) return null;
    // A bounty is the work itself: the job ends with its verified result, not when it is posted.
    if (booking.platform === 'bounty' && booking.status === 'completed') {
      const profile = candidateFor(job, booking.profileId)?.profile ?? store.getProfile(booking.profileId);
      const d = booking.delivery;
      const summary = d?.summary ?? d?.text ?? `Done by ${profile?.name ?? booking.profileId}.`;
      return complete(job, {
        outcome: 'booked',
        summary,
        work: { summary, data: d?.data ?? {}, ...(d?.urls?.length && { urls: d.urls }) },
        freelancer: profile ? { id: profile.id, platform: profile.platform, name: profile.name, url: profile.url, headline: profile.headline } : undefined,
        priceUsd: booking.priceUsd,
        bookingId: booking.id,
        bookingRef: booking.platformRef,
        bookingUrl: booking.url,
        ...(booking.resultHash && { verifiedResult: verifiedResultOf(booking) }),
      });
    }
    if (booking.platform !== 'bounty' && (booking.status === 'placed' || booking.status === 'handoff')) {
      const profile = candidateFor(job, booking.profileId)?.profile ?? store.getProfile(booking.profileId);
      const booked = booking.status === 'placed';
      const name = profile?.name ?? booking.profileId;
      return complete(job, {
        outcome: booked ? 'booked' : 'handoff',
        summary: booked
          ? `Booked ${name} on ${booking.platform} for $${booking.priceUsd}.`
          : `Escrow funded for ${name} on ${booking.platform} ($${booking.priceUsd}); finish the booking on the platform.${booking.note ? ` ${booking.note}` : ''}`,
        freelancer: profile ? { id: profile.id, platform: profile.platform, name: profile.name, url: profile.url, headline: profile.headline } : undefined,
        priceUsd: booking.priceUsd,
        bookingId: booking.id,
        bookingRef: booking.platformRef,
        bookingUrl: booking.url,
      });
    }
    if (booking.status === 'cancelled' || booking.status === 'refunded') {
      return complete(job, { outcome: 'no_booking', summary: `Booking ended (${booking.status})${booking.note ? `: ${booking.note}` : ''}.`, bookingId: booking.id });
    }
    return null;
  }

  bus.on((event) => {
    if (event.type !== 'booking.updated') return;
    try {
      const job = store.getJob(event.booking.jobId);
      if (job) settle(job, event.booking);
    } catch (err) {
      console.error('[jobs] booking.updated handler failed:', err);
    }
  });

  return {
    startJob(input) {
      const t = now();
      const job: Job = {
        id: input.id ?? newId('job'),
        status: input.awaitPayment ? 'awaiting_payment' : 'running',
        client: input.client,
        clientRef: input.clientRef,
        brief: input.brief,
        round: 1,
        createdAt: t,
        updatedAt: t,
      };
      store.insertJob(job);
      bus.emit({ type: 'job.updated', job });
      if (!input.awaitPayment) routeInBackground(job.id);
      return job;
    },

    markPaid(jobId) {
      const job = store.getJob(jobId);
      if (!job) throw new Error(`Job not found: ${jobId}`);
      if (job.status !== 'awaiting_payment') return;
      move(jobId, 'running', job.payment ? { payment: { ...job.payment, paidAt: now() } } : {});
      routeInBackground(jobId);
    },

    getJob: (id) => store.getJob(id),
    getShortlist: (jobId) => store.latestShortlist(jobId),

    provideInput(jobId, input: UserInput) {
      const job = store.getJob(jobId);
      if (!job) throw new Error(`Job not found: ${jobId}`);
      if (job.status !== 'awaiting_input') throw new Error(`Job ${jobId} is ${job.status}, not awaiting_input; cannot accept input`);

      if (input.action === 'cancel') {
        return complete(job, { outcome: 'no_booking', summary: 'Cancelled by the person hiring.' });
      }

      if (input.action === 'confirm') {
        const candidate = candidateFor(job, input.profileId);
        if (!candidate) throw new Error(`Profile ${input.profileId} is not on the latest shortlist of job ${jobId}`);
        const booking = bookings.create(job, candidate);
        const running = move(jobId, 'running', { selectedProfileId: candidate.profile.id, bookingId: booking.id });
        // The booking may already have settled while create() was returning.
        const current = store.getBooking(booking.id) ?? booking;
        return settle(running, current) ?? running;
      }

      // refine
      const latest = (job.shortlistId && store.getShortlist(job.shortlistId)) || store.latestShortlist(jobId);
      const exclude = new Set([...readList(excludeKey(jobId)), ...(latest?.candidates.map((c) => c.profile.id) ?? [])]);
      store.setKv(excludeKey(jobId), JSON.stringify([...exclude]));
      store.setKv(feedbackKey(jobId), input.feedback);
      const patch = Object.fromEntries(Object.entries(input.brief ?? {}).filter(([, v]) => v !== undefined)) as Partial<Brief>;
      const running = move(jobId, 'running', { brief: { ...job.brief, ...patch }, round: job.round + 1 });
      routeInBackground(jobId);
      return running;
    },

    async tick() {
      const t = now();
      const timeoutMs = config.CHECKIN_TIMEOUT_MIN * 60_000;
      for (const job of store.listJobs({ status: 'running' })) {
        try {
          if (job.bookingId) {
            const booking = store.getBooking(job.bookingId);
            if (booking) settle(job, booking);
          } else {
            const sl = store.latestShortlist(job.id);
            if (!sl || sl.round < job.round) routeInBackground(job.id);
          }
        } catch (err) {
          console.error(`[jobs] tick failed for ${job.id}:`, err);
        }
      }
      for (const job of store.listJobs({ status: 'awaiting_input' })) {
        try {
          if (t - job.updatedAt > timeoutMs) complete(job, { outcome: 'no_booking', summary: 'The check-in expired without an answer.' });
        } catch (err) {
          console.error(`[jobs] tick failed for ${job.id}:`, err);
        }
      }
    },
  };
}
