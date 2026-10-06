import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import { createStore } from '../db/db';
import { createEventBus } from '../domain/events';
import type { ApprovalGate, EscrowProvider, FreelancerSource, SourceRegistry } from '../domain/ports';
import type { BookingRequest, BookingResult, Candidate, EscrowRecord, HaasEvent, Job, PlatformBookingStatus } from '../domain/types';
import { createBookingService, escrowDeadline, payeeFor } from './bookings';

const job: Job = { id: 'j1', status: 'running', client: 'local', brief: { task: 'logo', skills: [], remoteOk: true, budgetUsd: 90 }, round: 1, createdAt: 1, updatedAt: 1 };
const cand = (quoteUsd?: number): Candidate => ({
  profile: { id: 'fake:a', platform: 'fake', platformId: 'a', url: 'https://x/a', name: 'Ada', headline: 'Logo designer', skills: [], pricing: [], fetchedAt: 1 },
  score: 80, subscores: { suitability: 1, price: 1, rating: 1, availability: 1, speed: 1 }, reason: 'r', unknowns: [], quoteUsd,
});

interface Opts {
  funded?: boolean;
  approve?: boolean | (() => Promise<boolean>);
  book?: (r: BookingRequest) => Promise<BookingResult>;
  noBook?: boolean;
  status?: () => Promise<PlatformBookingStatus>;
  config?: Parameters<typeof testConfig>[0];
}

function setup(o: Opts = {}) {
  const store = createStore(':memory:');
  store.insertJob(job);
  const bus = createEventBus();
  const events: HaasEvent[] = [];
  bus.on((e) => events.push(e));
  const order: string[] = [];

  const source: FreelancerSource = {
    name: 'fake-src', platform: 'fake', kind: 'fixture', isEnabled: () => true, search: async () => [],
    ...(o.noBook ? {} : { book: vi.fn(async (r: BookingRequest) => { order.push('book'); return o.book ? o.book(r) : { kind: 'placed' as const, platformRef: 'ord1', url: 'https://x/ord1' }; }) }),
    getBookingStatus: vi.fn(o.status ?? (async () => ({ status: 'placed' as const }))),
    acceptDelivery: vi.fn(async () => {}),
    requestRevision: vi.fn(async () => {}),
  };
  const registry: SourceRegistry = { all: () => [source], enabled: () => [source], get: (n) => (n === source.name ? source : undefined), searchAll: async () => ({ profiles: [], sources: [] }) };

  let funded = o.funded ?? true;
  const clock = { t: 1_000_000 };
  const escrow: EscrowProvider = {
    name: 'test', currency: 'USDC',
    create: vi.fn(async ({ bookingId, amountUsd, payee, deadline }) => ({ id: `es_${bookingId}`, bookingId, provider: 'test', status: funded ? ('funded' as const) : ('awaiting_deposit' as const), amount: amountUsd, currency: 'USDC', payee, deadline, createdAt: clock.t, updatedAt: clock.t })),
    refresh: vi.fn(async (e: EscrowRecord) => ({ ...e, status: funded ? ('funded' as const) : e.status })),
    release: vi.fn(async (e: EscrowRecord) => ({ ...e, status: 'released' as const })),
    refund: vi.fn(async (e: EscrowRecord) => ({ ...e, status: 'refunded' as const })),
  };
  const asked: string[] = [];
  const gate: ApprovalGate = {
    request: vi.fn(async (req) => {
      asked.push(req.action);
      if (req.action === 'book') order.push('approval');
      const a = typeof o.approve === 'function' ? await o.approve() : (o.approve ?? true);
      return { approved: a };
    }),
    resolve: () => {},
  };
  const svc = createBookingService({ store, bus, registry, escrow, gate, config: testConfig(o.config), now: () => clock.t });
  const status = (id: string) => store.getBooking(id)!.status;
  return { store, events, svc, source, escrow, gate, asked, order, status, clock, fund: () => { funded = true; } };
}

describe('bookings.create', () => {
  it('prices from the quote, then budget, then 0, and picks the matching source', async () => {
    const h = setup({ funded: false });
    const b = h.svc.create(job, cand(42));
    expect(b).toMatchObject({ status: 'pending_escrow', priceUsd: 42, source: 'fake-src', platform: 'fake', paused: false });
    expect(h.svc.create(job, cand()).priceUsd).toBe(90);
    expect(h.svc.create({ ...job, brief: { ...job.brief, budgetUsd: undefined } }, cand()).priceUsd).toBe(0);
  });

  it('auto-funded escrow: persists escrow, asks the book approval and places', async () => {
    const h = setup();
    const b = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.status(b.id)).toBe('placed'));
    const done = h.store.getBooking(b.id)!;
    expect(done).toMatchObject({ platformRef: 'ord1', url: 'https://x/ord1', escrowId: `es_${b.id}` });
    expect(h.store.getEscrowByBooking(b.id)?.status).toBe('funded');
    const req = vi.mocked(h.gate.request).mock.calls[0]![0];
    expect(req).toMatchObject({ action: 'book', jobId: 'j1', bookingId: b.id });
    expect(req.summary).toMatch(/Ada/);
    expect(req.summary).toMatch(/fake/);
    expect(req.summary).toMatch(/50/);
    const seen = h.events.filter((e) => e.type === 'booking.updated').map((e) => (e as { booking: { status: string } }).booking.status);
    expect(seen).toEqual(['pending_escrow', 'pending_escrow', 'escrowed', 'awaiting_approval', 'placed']);
    expect(h.events.some((e) => e.type === 'escrow.updated')).toBe(true);
    expect(vi.mocked(h.source.book!).mock.calls[0]![0]).toMatchObject({ bookingId: b.id, priceUsd: 50, profile: { id: 'fake:a' }, brief: { task: 'logo' } });
  });

  it('waits for a deposit that arrives on a later tick', async () => {
    const h = setup({ funded: false });
    const b = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.store.getBooking(b.id)?.escrowId).toBeTruthy());
    await h.svc.tick();
    expect(h.status(b.id)).toBe('pending_escrow');
    expect(h.source.book).not.toHaveBeenCalled();
    h.fund();
    await h.svc.tick();
    await vi.waitFor(() => expect(h.status(b.id)).toBe('placed'));
    expect(h.store.getEscrowByBooking(b.id)?.status).toBe('funded');
  });

  it('refunds when the approval is denied', async () => {
    const h = setup({ approve: false });
    const b = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.status(b.id)).toBe('refunded'));
    expect(h.source.book).not.toHaveBeenCalled();
    expect(h.escrow.refund).toHaveBeenCalledTimes(1);
    expect(h.store.getEscrowByBooking(b.id)?.status).toBe('refunded');
    expect(h.store.getBooking(b.id)?.note).toMatch(/not approved/);
    const seen = h.events.filter((e) => e.type === 'booking.updated').map((e) => (e as { booking: { status: string } }).booking.status);
    expect(seen).toContain('cancelled');
  });

  it('refunds when book() throws', async () => {
    const h = setup({ book: async () => { throw new Error('site down'); } });
    const b = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.status(b.id)).toBe('refunded'));
    expect(h.store.getBooking(b.id)?.note).toMatch(/site down/);
    expect(h.store.getEscrowByBooking(b.id)?.status).toBe('refunded');
  });

  it('maps a handoff result and keeps the instructions in note', async () => {
    const h = setup({ book: async () => ({ kind: 'handoff', url: 'https://x/pay', instructions: 'Click pay', platformRef: 'o9' }) });
    const b = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.status(b.id)).toBe('handoff'));
    expect(h.store.getBooking(b.id)).toMatchObject({ url: 'https://x/pay', note: 'Click pay', platformRef: 'o9' });
  });

  it('goes to handoff with the profile URL when the source has no book()', async () => {
    const h = setup({ noBook: true });
    const b = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.status(b.id)).toBe('handoff'));
    expect(h.store.getBooking(b.id)?.url).toBe('https://x/a');
    expect(h.asked).toEqual(['book']);
  });

  it('never calls book() before escrow is funded and the book approval is granted', async () => {
    let grant!: () => void;
    const h = setup({ funded: false, approve: () => new Promise<boolean>((r) => { grant = () => r(true); }) });
    const b = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.store.getBooking(b.id)?.escrowId).toBeTruthy());
    await h.svc.tick();
    await h.svc.tick();
    expect(h.source.book).not.toHaveBeenCalled(); // unfunded
    expect(h.gate.request).not.toHaveBeenCalled();
    h.fund();
    await h.svc.tick();
    await vi.waitFor(() => expect(h.status(b.id)).toBe('awaiting_approval'));
    await h.svc.tick(); // funded and waiting: must not request a second approval or book
    await new Promise((r) => setTimeout(r, 20));
    expect(h.source.book).not.toHaveBeenCalled(); // funded, approval pending
    expect(vi.mocked(h.gate.request).mock.calls.filter(([r]) => r.action === 'book')).toHaveLength(1);
    grant();
    await vi.waitFor(() => expect(h.status(b.id)).toBe('placed'));
    expect(h.order).toEqual(['approval', 'book']);
    expect(h.source.book).toHaveBeenCalledTimes(1);
  });
});

describe('bookings settle', () => {
  async function placed(o: Opts = {}) {
    const h = setup(o);
    const b = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.status(b.id)).toBe('placed'));
    return { h, id: b.id };
  }

  it('accept asks the gate, accepts delivery, completes and releases escrow', async () => {
    const { h, id } = await placed();
    const done = await h.svc.accept(id);
    expect(done.status).toBe('completed');
    expect(h.asked).toContain('accept');
    expect(h.source.acceptDelivery).toHaveBeenCalledWith('ord1');
    expect(h.escrow.release).toHaveBeenCalledTimes(1);
    expect(h.store.getEscrowByBooking(id)?.status).toBe('released');
  });

  it('accept leaves the booking unchanged when denied', async () => {
    const { h, id } = await placed();
    vi.mocked(h.gate.request).mockResolvedValueOnce({ approved: false });
    const same = await h.svc.accept(id);
    expect(same.status).toBe('placed');
    expect(h.escrow.release).not.toHaveBeenCalled();
    expect(h.source.acceptDelivery).not.toHaveBeenCalled();
  });

  it('requestRevision moves to in_revision', async () => {
    const { h, id } = await placed();
    const b = await h.svc.requestRevision(id, 'bluer please');
    expect(b.status).toBe('in_revision');
    expect(h.source.requestRevision).toHaveBeenCalledWith('ord1', 'bluer please');
    expect(h.asked).toContain('revise');
  });

  it('cancel refunds escrow; denial changes nothing; final bookings throw', async () => {
    const { h, id } = await placed();
    vi.mocked(h.gate.request).mockResolvedValueOnce({ approved: false });
    expect((await h.svc.cancel(id, 'changed mind')).status).toBe('placed');
    const b = await h.svc.cancel(id, 'changed mind');
    expect(b.status).toBe('refunded');
    expect(b.note).toBe('changed mind');
    expect(h.store.getEscrowByBooking(id)?.status).toBe('refunded');
    await expect(h.svc.cancel(id, 'again')).rejects.toThrow();
    await expect(h.svc.accept(id)).rejects.toThrow();
  });

  it('tick polls the platform and applies status; one failing booking does not stop the loop', async () => {
    let call = 0;
    const { h, id } = await placed({
      status: async () => {
        if (++call === 1) throw new Error('flaky');
        return { status: 'delivered', deliveryText: 'here it is' };
      },
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.status(second.id)).toBe('placed'));
    await h.svc.tick(); // first booking throws, second still polled
    expect(err).toHaveBeenCalled();
    expect([h.status(id), h.status(second.id)].sort()).toEqual(['delivered', 'placed']);
    await h.svc.tick();
    expect(h.status(id)).toBe('delivered');
    expect(h.store.getBooking(id)?.note).toContain('here it is');
    err.mockRestore();
  });

  it('tick refunds when the platform reports a cancellation, and releases on completion', async () => {
    const a = await placed({ status: async () => ({ status: 'cancelled' }) });
    await a.h.svc.tick();
    expect(a.h.status(a.id)).toBe('refunded');
    const b = await placed({ status: async () => ({ status: 'completed' }) });
    await b.h.svc.tick();
    expect(b.h.status(b.id)).toBe('completed');
    expect(b.h.store.getEscrowByBooking(b.id)?.status).toBe('released');
  });
});

describe('escrow terms', () => {
  const MIN = 60_000;
  it('pays the worker wallet when published, else the operator; deadline = delivery window + grace', async () => {
    const wallet = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    const h = setup({ funded: false });
    const c = cand(50);
    c.profile = { ...c.profile, solanaWallet: wallet };
    const b = h.svc.create({ ...job, brief: { ...job.brief, deadlineDays: 3 } }, c);
    await vi.waitFor(() => expect(h.store.getEscrowByBooking(b.id)).toBeTruthy());
    expect(h.escrow.create).toHaveBeenCalledWith({ bookingId: b.id, amountUsd: 50, payee: wallet, deadline: h.clock.t + 3 * 1440 * MIN + 24 * 60 * MIN });
    expect(h.store.getBooking(b.id)?.payeeWallet).toBe(wallet);

    const b2 = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.store.getEscrowByBooking(b2.id)).toBeTruthy());
    expect(vi.mocked(h.escrow.create).mock.calls[1]![0].payee).toBeUndefined();
    expect(h.store.getBooking(b2.id)?.payeeWallet).toBeUndefined();
  });

  it('ignores malformed wallets and honours the demo deadline override', () => {
    expect(payeeFor({ solanaWallet: 'not a wallet' } as never)).toBeUndefined();
    expect(payeeFor(undefined)).toBeUndefined();
    expect(escrowDeadline(testConfig({ ESCROW_DEADLINE_MIN: 5 }), { task: '', skills: [], remoteOk: true, deadlineDays: 9 }, 1000)).toBe(1000 + 5 * MIN);
    expect(escrowDeadline(testConfig(), undefined, 0)).toBe(14 * 1440 * MIN + 24 * 60 * MIN);
  });
});

describe('escrow timeouts', () => {
  const MIN = 60_000;

  it('cancels a booking whose deposit never arrived within the window, without calling refund', async () => {
    const h = setup({ funded: false, config: { ESCROW_DEPOSIT_TIMEOUT_MIN: 30 } });
    const b = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.store.getEscrowByBooking(b.id)).toBeTruthy());
    h.clock.t += 29 * MIN;
    await h.svc.tick();
    expect(h.status(b.id)).toBe('pending_escrow');
    h.clock.t += 2 * MIN;
    await h.svc.tick();
    expect(h.status(b.id)).toBe('cancelled');
    expect(h.store.getEscrowByBooking(b.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('30 min') });
    expect(h.escrow.refund).not.toHaveBeenCalled();
    const ev = h.events.find((e) => e.type === 'escrow.timeout');
    expect(ev).toMatchObject({ type: 'escrow.timeout', kind: 'deposit_expired', booking: { id: b.id, status: 'cancelled' } });
    await h.svc.tick(); // stays cancelled, nothing to refund
    expect(h.status(b.id)).toBe('cancelled');
    expect(h.escrow.refund).not.toHaveBeenCalled();
  });

  it('a deposit seen on the last tick before the window closes still wins', async () => {
    const h = setup({ funded: false, config: { ESCROW_DEPOSIT_TIMEOUT_MIN: 30 } });
    const b = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.store.getEscrowByBooking(b.id)).toBeTruthy());
    h.clock.t += 31 * MIN;
    h.fund();
    await h.svc.tick();
    await vi.waitFor(() => expect(h.status(b.id)).toBe('placed'));
  });

  it('refunds a funded booking with no accepted delivery once the escrow deadline passes', async () => {
    const h = setup({ config: { ESCROW_DEADLINE_MIN: 60 } });
    const b = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.status(b.id)).toBe('placed'));
    h.clock.t += 59 * MIN;
    await h.svc.tick();
    expect(h.status(b.id)).toBe('placed');
    h.clock.t += 2 * MIN;
    await h.svc.tick();
    expect(h.status(b.id)).toBe('refunded');
    expect(h.escrow.refund).toHaveBeenCalledTimes(1);
    expect(h.store.getEscrowByBooking(b.id)?.status).toBe('refunded');
    expect(h.events.find((e) => e.type === 'escrow.timeout')).toMatchObject({ kind: 'delivery_expired', booking: { status: 'refunded' }, escrow: { status: 'refunded' } });
  });

  it('does not book when the deadline passed while the approval was pending', async () => {
    let release!: (v: boolean) => void;
    const h = setup({ config: { ESCROW_DEADLINE_MIN: 60 }, approve: () => new Promise<boolean>((r) => (release = r)) });
    const b = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.status(b.id)).toBe('awaiting_approval'));
    h.clock.t += 61 * MIN;
    await h.svc.tick(); // busy: skipped while the approval is open
    release(true);
    await vi.waitFor(() => expect(h.status(b.id)).toBe('refunded'));
    expect(h.source.book).not.toHaveBeenCalled();
  });

  it('refunds a rejected deposit (wrong amount or mint)', async () => {
    const h = setup({ funded: false });
    const b = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.store.getEscrowByBooking(b.id)).toBeTruthy());
    vi.mocked(h.escrow.refresh).mockImplementationOnce(async (e) => ({ ...e, status: 'failed', payer: 'hirer', error: 'deposit rejected: deposit is 1 USDC, expected 50' }));
    await h.svc.tick();
    expect(h.status(b.id)).toBe('refunded');
    expect(h.store.getBooking(b.id)?.note).toContain('deposit rejected');
  });
});

describe('releaseOnVerified', () => {
  async function placed(o: Opts = {}) {
    const h = setup(o);
    const b = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.status(b.id)).toBe('placed'));
    return { h, id: b.id };
  }
  const HASH = 'ab'.repeat(32);

  it('asks the accept approval, accepts on the platform, completes and releases with the result hash', async () => {
    const { h, id } = await placed();
    const done = await h.svc.releaseOnVerified!(id, HASH);
    expect(done.status).toBe('completed');
    expect(h.asked).toEqual(['book', 'accept']);
    expect(h.source.acceptDelivery).toHaveBeenCalledWith('ord1');
    expect(h.escrow.release).toHaveBeenCalledWith(expect.objectContaining({ bookingId: id }), { resultHash: HASH });
    expect(h.store.getEscrowByBooking(id)?.status).toBe('released');
  });

  it('skips the approval when preApproved, and does nothing when denied', async () => {
    const a = await placed();
    await a.h.svc.releaseOnVerified!(a.id, HASH, { preApproved: true });
    expect(a.h.asked).toEqual(['book']);
    const b = await placed();
    vi.mocked(b.h.gate.request).mockResolvedValueOnce({ approved: false });
    expect((await b.h.svc.releaseOnVerified!(b.id, HASH)).status).toBe('placed');
    expect(b.h.escrow.release).not.toHaveBeenCalled();
  });

  it('refuses after the deadline and for bookings not yet placed', async () => {
    const a = await placed({ config: { ESCROW_DEADLINE_MIN: 10 } });
    a.h.clock.t += 11 * 60_000;
    await expect(a.h.svc.releaseOnVerified!(a.id, HASH, { preApproved: true })).rejects.toThrow(/deadline/);
    const h = setup({ funded: false });
    const b = h.svc.create(job, cand(50));
    await expect(h.svc.releaseOnVerified!(b.id, HASH)).rejects.toThrow(/pending_escrow/);
  });

  it('a failed release is retried by tick with the same result hash', async () => {
    const { h, id } = await placed();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(h.escrow.release).mockRejectedValueOnce(new Error('rpc down'));
    const done = await h.svc.releaseOnVerified!(id, HASH, { preApproved: true });
    expect(done.status).toBe('completed');
    expect(h.store.getEscrowByBooking(id)?.status).toBe('funded');
    await h.svc.tick();
    expect(h.store.getEscrowByBooking(id)?.status).toBe('released');
    expect(vi.mocked(h.escrow.release).mock.calls[1]![1]).toEqual({ resultHash: HASH });
    err.mockRestore();
  });
});
