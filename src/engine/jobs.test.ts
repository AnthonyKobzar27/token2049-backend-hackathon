import { describe, expect, it, vi, afterEach } from 'vitest';
import { testConfig } from '../config';
import { createStore } from '../db/db';
import { createEventBus } from '../domain/events';
import type { BookingService, Router } from '../domain/ports';
import type { Booking, Brief, Candidate, HaasEvent } from '../domain/types';
import { createJobService } from './jobs';

afterEach(() => vi.restoreAllMocks());

const brief: Brief = { task: 'logo', skills: ['design'], remoteOk: true, budgetUsd: 100 };
const cand = (n: string): Candidate => ({
  profile: { id: `fake:${n}`, platform: 'fake', platformId: n, url: `https://x/${n}`, name: n, headline: 'h', skills: [], pricing: [], fetchedAt: 1 },
  score: 80, subscores: { suitability: 1, price: 1, rating: 1, availability: 1, speed: 1 }, reason: 'r', unknowns: [], quoteUsd: 50,
});

function setup(route?: Router['route']) {
  const store = createStore(':memory:');
  const bus = createEventBus();
  const events: HaasEvent[] = [];
  bus.on((e) => events.push(e));
  const calls: Parameters<Router['route']>[] = [];
  const pool = [cand('a'), cand('b'), cand('c'), cand('d')];
  const router: Router = {
    route:
      route ??
      (async (b, opts) => {
        calls.push([b, opts]);
        const ex = new Set(opts.exclude ?? []);
        return { candidates: pool.filter((c) => !ex.has(c.profile.id)).slice(0, 2), sources: [] };
      }),
  };
  const created: Booking[] = [];
  const bookings: BookingService = {
    create(job, candidate) {
      const b: Booking = { id: `bk${created.length + 1}`, jobId: job.id, profileId: candidate.profile.id, platform: 'fake', source: 'fake', status: 'pending_escrow', priceUsd: 50, paused: false, createdAt: 1, updatedAt: 1 };
      store.insertBooking(b);
      created.push(b);
      return b;
    },
    get: (id) => store.getBooking(id),
    accept: async (id) => store.getBooking(id)!,
    requestRevision: async (id) => store.getBooking(id)!,
    cancel: async (id) => store.getBooking(id)!,
    tick: async () => {},
  };
  const config = testConfig({ CHECKIN_TIMEOUT_MIN: 10 });
  const jobs = createJobService({ store, bus, router, bookings, config });
  const setBooking = (id: string, status: Booking['status']) => {
    const booking = store.updateBooking(id, { status });
    bus.emit({ type: 'booking.updated', booking });
  };
  return { store, bus, events, jobs, calls, created, setBooking, config };
}

const settled = (store: ReturnType<typeof setup>['store'], id: string, status: string) =>
  vi.waitFor(() => expect(store.getJob(id)?.status).toBe(status));

describe('jobs', () => {
  it('a pinned person skips the search: the shortlist is just them, until the hirer asks for other options', async () => {
    const { jobs, store, calls } = setup();
    const person = cand('tasya').profile;
    const job = jobs.startJob({ brief, client: 'telegram', clientRef: '7', pinned: person });
    await settled(store, job.id, 'awaiting_input');
    expect(calls[0]![1].only).toEqual([person]);
    expect(store.getJob(job.id)?.path).toBe('human');
    jobs.provideInput(job.id, { action: 'refine', feedback: 'someone else' });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]![1].only).toBeUndefined();
  });

  it('routes in the background and reaches awaiting_input with a shortlist', async () => {
    const { jobs, store, events } = setup();
    const job = jobs.startJob({ brief, client: 'local' });
    expect(job.status).toBe('running');
    await settled(store, job.id, 'awaiting_input');
    const sl = jobs.getShortlist(job.id)!;
    expect(sl.round).toBe(1);
    expect(sl.candidates).toHaveLength(2);
    expect(store.getJob(job.id)?.shortlistId).toBe(sl.id);
    expect(events.some((e) => e.type === 'shortlist.ready')).toBe(true);
    expect(events.filter((e) => e.type === 'job.updated').length).toBeGreaterThanOrEqual(2);
  });

  it('passes limit, exclude and feedback to the router', async () => {
    const { jobs, store, calls, config } = setup();
    const job = jobs.startJob({ brief, client: 'local' });
    await settled(store, job.id, 'awaiting_input');
    expect(calls[0]![1]).toMatchObject({ jobId: job.id, limit: config.SHORTLIST_SIZE, exclude: [] });
  });

  it('starts in awaiting_payment and routes on markPaid', async () => {
    const { jobs, store, calls } = setup();
    const job = jobs.startJob({ brief, client: 'masumi', awaitPayment: true, id: 'job_fixed' });
    expect(job.id).toBe('job_fixed');
    expect(job.status).toBe('awaiting_payment');
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(0);
    jobs.markPaid(job.id);
    await settled(store, job.id, 'awaiting_input');
  });

  it('goes to awaiting_input with an empty candidate list', async () => {
    const { jobs, store } = setup(async () => ({ candidates: [], sources: [] }));
    const job = jobs.startJob({ brief, client: 'local' });
    await settled(store, job.id, 'awaiting_input');
    expect(jobs.getShortlist(job.id)?.candidates).toEqual([]);
  });

  it('fails the job when routing throws', async () => {
    const { jobs, store } = setup(async () => {
      throw new Error('boom');
    });
    const job = jobs.startJob({ brief, client: 'local' });
    await settled(store, job.id, 'failed');
    expect(store.getJob(job.id)?.error).toBe('boom');
  });

  it('happy path: confirm creates a booking and completes as booked', async () => {
    const { jobs, store, created, setBooking } = setup();
    const job = jobs.startJob({ brief, client: 'local' });
    await settled(store, job.id, 'awaiting_input');
    expect(() => jobs.provideInput(job.id, { action: 'confirm', profileId: 'fake:zzz' })).toThrow(/not on the latest shortlist/);
    const running = jobs.provideInput(job.id, { action: 'confirm', profileId: 'fake:a' });
    expect(running).toMatchObject({ status: 'running', selectedProfileId: 'fake:a', bookingId: created[0]!.id });
    setBooking(created[0]!.id, 'placed');
    const done = store.getJob(job.id)!;
    expect(done.status).toBe('completed');
    expect(done.result).toMatchObject({ outcome: 'booked', bookingId: created[0]!.id, priceUsd: 50 });
    expect(done.result?.freelancer?.id).toBe('fake:a');
  });

  it('completes as handoff, and as no_booking when the booking is cancelled first', async () => {
    const { jobs, store, created, setBooking } = setup();
    const j1 = jobs.startJob({ brief, client: 'local' });
    await settled(store, j1.id, 'awaiting_input');
    jobs.provideInput(j1.id, { action: 'confirm', profileId: 'fake:a' });
    setBooking(created[0]!.id, 'handoff');
    expect(store.getJob(j1.id)?.result?.outcome).toBe('handoff');

    const j2 = jobs.startJob({ brief, client: 'local' });
    await settled(store, j2.id, 'awaiting_input');
    jobs.provideInput(j2.id, { action: 'confirm', profileId: 'fake:b' });
    setBooking(created[1]!.id, 'cancelled');
    setBooking(created[1]!.id, 'refunded');
    expect(store.getJob(j2.id)).toMatchObject({ status: 'completed', result: { outcome: 'no_booking' } });
  });

  it('refine merges the brief, bumps the round and excludes earlier candidates', async () => {
    const { jobs, store, calls } = setup();
    const job = jobs.startJob({ brief, client: 'local' });
    await settled(store, job.id, 'awaiting_input');
    const r = jobs.provideInput(job.id, { action: 'refine', feedback: 'cheaper please', brief: { budgetUsd: 40, location: undefined } });
    expect(r).toMatchObject({ status: 'running', round: 2 });
    await vi.waitFor(() => expect(store.getJob(job.id)?.status).toBe('awaiting_input'));
    expect(store.getJob(job.id)?.brief).toMatchObject({ task: 'logo', budgetUsd: 40, skills: ['design'] });
    expect(calls[1]![1]).toMatchObject({ feedback: 'cheaper please', exclude: ['fake:a', 'fake:b'] });
    expect(jobs.getShortlist(job.id)).toMatchObject({ round: 2 });
    expect(jobs.getShortlist(job.id)?.candidates.map((c) => c.profile.id)).toEqual(['fake:c', 'fake:d']);

    jobs.provideInput(job.id, { action: 'refine', feedback: 'more' });
    await vi.waitFor(() => expect(jobs.getShortlist(job.id)?.round).toBe(3));
    expect(calls[2]![1].exclude).toEqual(expect.arrayContaining(['fake:a', 'fake:b', 'fake:c', 'fake:d']));
  });

  it('cancel completes with no_booking', async () => {
    const { jobs, store } = setup();
    const job = jobs.startJob({ brief, client: 'local' });
    await settled(store, job.id, 'awaiting_input');
    const done = jobs.provideInput(job.id, { action: 'cancel' });
    expect(done).toMatchObject({ status: 'completed', result: { outcome: 'no_booking' } });
  });

  it('provideInput outside awaiting_input throws', async () => {
    const { jobs, store } = setup();
    const job = jobs.startJob({ brief, client: 'local', awaitPayment: true });
    expect(() => jobs.provideInput(job.id, { action: 'cancel' })).toThrow(/not awaiting_input/);
    expect(() => jobs.provideInput('missing', { action: 'cancel' })).toThrow(/not found/);
    jobs.markPaid(job.id);
    await settled(store, job.id, 'awaiting_input');
    jobs.provideInput(job.id, { action: 'cancel' });
    expect(() => jobs.provideInput(job.id, { action: 'cancel' })).toThrow(/not awaiting_input/);
  });

  it('tick expires stale check-ins only', async () => {
    const { jobs, store, config } = setup();
    const job = jobs.startJob({ brief, client: 'local' });
    await settled(store, job.id, 'awaiting_input');
    await jobs.tick();
    expect(store.getJob(job.id)?.status).toBe('awaiting_input');
    const t = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t + config.CHECKIN_TIMEOUT_MIN * 60_000 + 1000);
    await jobs.tick();
    const done = store.getJob(job.id)!;
    expect(done.status).toBe('completed');
    expect(done.result?.outcome).toBe('no_booking');
    expect(done.result?.summary).toMatch(/expired/);
  });

  it('tick resumes interrupted routing, once', async () => {
    const h = setup();
    // Simulate a restart: a job left 'running' with no shortlist.
    h.store.insertJob({ id: 'jr', status: 'running', client: 'local', brief, round: 1, createdAt: 1, updatedAt: 1 });
    await Promise.all([h.jobs.tick(), h.jobs.tick()]);
    await settled(h.store, 'jr', 'awaiting_input');
    expect(h.calls).toHaveLength(1);
    // A refined job interrupted in round 2 is routed again as well.
    h.store.updateJob('jr', { status: 'running', round: 2 });
    await h.jobs.tick();
    await vi.waitFor(() => expect(h.jobs.getShortlist('jr')?.round).toBe(2));
  });

  it('tick completes running jobs whose booking already finished, and leaves open ones', async () => {
    const h = setup();
    h.store.insertJob({ id: 'jb', status: 'running', client: 'local', brief, round: 1, bookingId: 'bkx', createdAt: 1, updatedAt: 1 });
    h.store.insertBooking({ id: 'bkx', jobId: 'jb', profileId: 'fake:a', platform: 'fake', source: 'fake', status: 'escrowed', priceUsd: 5, paused: false, createdAt: 1, updatedAt: 1 });
    await h.jobs.tick();
    expect(h.store.getJob('jb')?.status).toBe('running');
    h.store.updateBooking('bkx', { status: 'placed' });
    await h.jobs.tick();
    expect(h.store.getJob('jb')).toMatchObject({ status: 'completed', result: { outcome: 'booked' } });
    expect(h.calls).toHaveLength(0);
  });
});

describe('paid result window', () => {
  const pay = (submitResultTime: number) => ({ blockchainIdentifier: 'bc', identifierFromPurchaser: 'ifp', payByTime: 0, submitResultTime, unlockTime: 0, externalDisputeUnlockTime: 0, paidAt: 1 }) as never;

  it('refuses to book once the result can no longer be submitted in time, and ends the job', async () => {
    const { jobs, store, created } = setup();
    const job = jobs.startJob({ brief, client: 'masumi' });
    await settled(store, job.id, 'awaiting_input');
    store.updateJob(job.id, { payment: pay(Date.now() + 5 * 60_000) });
    expect(() => jobs.provideInput(job.id, { action: 'confirm', profileId: 'fake:a' })).toThrow(/result window has closed/);
    expect(created).toHaveLength(0);
    expect(store.getJob(job.id)).toMatchObject({ status: 'completed', result: { outcome: 'no_booking' } });
  });

  it('closes an unanswered check-in before the result deadline, not only after CHECKIN_TIMEOUT_MIN', async () => {
    const { jobs, store } = setup();
    const open = jobs.startJob({ brief, client: 'masumi' });
    const late = jobs.startJob({ brief, client: 'masumi' });
    await settled(store, open.id, 'awaiting_input');
    await settled(store, late.id, 'awaiting_input');
    store.updateJob(open.id, { payment: pay(Date.now() + 60 * 60_000) });
    store.updateJob(late.id, { payment: pay(Date.now() + 9 * 60_000) });
    await jobs.tick();
    expect(store.getJob(open.id)?.status).toBe('awaiting_input');
    expect(store.getJob(late.id)?.result?.summary).toMatch(/result window closed/);
  });
});
