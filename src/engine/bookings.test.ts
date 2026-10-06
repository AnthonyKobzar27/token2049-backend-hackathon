import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import { createStore } from '../db/db';
import { createEventBus } from '../domain/events';
import type { ApprovalGate, EscrowProvider, FreelancerSource, SourceRegistry } from '../domain/ports';
import type { BookingRequest, BookingResult, Candidate, EscrowRecord, HaasEvent, Job, PlatformBookingStatus } from '../domain/types';
import { verifiedResultHash } from '../verify/hash';
import type { RubricJudge } from '../verify/rubric';
import { createResultVerifier, type ResultVerifier } from '../verify/verifier';
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
  verifier?: ResultVerifier;
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
  const svc = createBookingService({ store, bus, registry, escrow, gate, config: testConfig(o.config), verifier: o.verifier, now: () => clock.t });
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
      // QA that never finishes, so the delivered bookings stay visible in 'verifying'.
      verifier: { verify: () => new Promise(() => {}) },
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.status(second.id)).toBe('placed'));
    await h.svc.tick(); // first booking throws, second still polled
    expect(err).toHaveBeenCalled();
    expect([h.status(id), h.status(second.id)].sort()).toEqual(['placed', 'verifying']);
    await h.svc.tick();
    expect(h.status(id)).toBe('verifying');
    expect(h.store.getBooking(id)?.note).toContain('here it is');
    expect(h.svc.delivery(id)).toEqual({ text: 'here it is' });
    err.mockRestore();
  });

  it('tick refunds when the platform reports a cancellation; a platform completion goes through QA before release', async () => {
    const a = await placed({ status: async () => ({ status: 'cancelled' }) });
    await a.h.svc.tick();
    expect(a.h.status(a.id)).toBe('refunded');
    const b = await placed({ status: async () => ({ status: 'completed' }) });
    await b.h.svc.tick();
    // No content and no model: QA asks a person (the test gate approves), then releases.
    await vi.waitFor(() => expect(b.h.status(b.id)).toBe('completed'));
    expect(b.h.store.getBooking(b.id)?.verification?.verdict).toBe('needs_human');
    expect(b.h.asked).toContain('accept');
    expect(b.h.store.getEscrowByBooking(b.id)?.status).toBe('released');
  });
});

describe('bookings QA before release', () => {
  // Rubric that passes deliveries containing "final" and fails the rest, unless overridden.
  const scripted = (judge?: RubricJudge) =>
    createResultVerifier({
      config: testConfig({ ANTHROPIC_API_KEY: 'k', VERIFY_TIMEOUT_MS: 600 }),
      rubric: judge ?? (async (req) => /final/.test(req.delivery.text ?? '')
        ? { verdict: 'pass', score: 0.9, checks: [{ name: 'logo', ok: true, detail: 'logo delivered' }], summary: 'Logo delivered as asked.' }
        : { verdict: 'fail', score: 0.2, checks: [{ name: 'logo', ok: false, detail: 'only a sketch, no final logo' }], summary: 'No final logo.' }),
    });

  async function placedWith(verifier: ResultVerifier) {
    const h = setup({ verifier });
    const b = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.status(b.id)).toBe('placed'));
    return { h, id: b.id };
  }
  const qaEvents = (h: ReturnType<typeof setup>) => h.events.filter((e) => e.type.startsWith('verification.')).map((e) => e.type);

  it('pass: asks the hirer with the QA summary, then releases bound to the result hash', async () => {
    const { h, id } = await placedWith(scripted());
    const releaseOnVerified = vi.fn(async (bookingId: string) => ({ ...h.store.getEscrowByBooking(bookingId)!, status: 'released' as const }));
    Object.assign(h.escrow, { releaseOnVerified });
    await h.svc.deliver(id, { text: 'Here is the final logo', urls: [] });
    await vi.waitFor(() => expect(h.status(id)).toBe('completed'));
    const b = h.store.getBooking(id)!;
    expect(b.verification?.verdict).toBe('pass');
    expect(b.resultHash).toBe(verifiedResultHash(id, { text: 'Here is the final logo' }));
    expect(releaseOnVerified).toHaveBeenCalledWith(id, b.resultHash);
    expect(h.escrow.release).not.toHaveBeenCalled();
    expect(h.store.getEscrowByBooking(id)?.status).toBe('released');
    const accept = vi.mocked(h.gate.request).mock.calls.map((c) => c[0]).find((r) => r.action === 'accept')!;
    expect(accept.summary).toMatch(/^QA passed/);
    expect(accept.detail).toContain('QA PASSED');
    expect(qaEvents(h)).toEqual(['verification.started', 'verification.completed']);
    const statuses = h.events.flatMap((e) => (e.type === 'booking.updated' && e.booking.id === id ? [e.booking.status] : []));
    expect(statuses).toEqual(expect.arrayContaining(['delivered', 'verifying', 'verified', 'completed']));
  });

  it('fail -> one revision with the failed checks -> pass', async () => {
    const { h, id } = await placedWith(scripted());
    await h.svc.deliver(id, { text: 'a rough sketch' });
    await vi.waitFor(() => expect(h.status(id)).toBe('in_revision'));
    expect(h.source.requestRevision).toHaveBeenCalledWith('ord1', expect.stringContaining('only a sketch, no final logo'));
    expect(h.escrow.release).not.toHaveBeenCalled();
    // The platform still shows the old delivery: not new work, no second QA run.
    await h.svc.deliver(id, { text: 'a rough sketch' });
    expect(h.status(id)).toBe('in_revision');
    await h.svc.deliver(id, { text: 'the final logo, as asked' });
    await vi.waitFor(() => expect(h.status(id)).toBe('completed'));
    expect(h.svc.verifications(id).map((r) => [r.verdict, r.attempt])).toEqual([['fail', 1], ['pass', 2]]);
    expect(h.store.getEscrowByBooking(id)?.status).toBe('released');
    expect(qaEvents(h)).toContain('verification.revision_requested');
  });

  it('fail twice -> rejected, no payout, escrow refunded', async () => {
    const { h, id } = await placedWith(scripted());
    await h.svc.deliver(id, { text: 'a rough sketch' });
    await vi.waitFor(() => expect(h.status(id)).toBe('in_revision'));
    await h.svc.deliver(id, { text: 'another rough sketch' });
    await vi.waitFor(() => expect(h.status(id)).toBe('refunded'));
    expect(h.escrow.release).not.toHaveBeenCalled();
    expect(h.source.acceptDelivery).not.toHaveBeenCalled();
    expect(h.store.getEscrowByBooking(id)?.status).toBe('refunded');
    expect(h.asked).not.toContain('accept');
    expect(qaEvents(h)).toContain('verification.rejected');
    const statuses = h.events.flatMap((e) => (e.type === 'booking.updated' && e.booking.id === id ? [e.booking.status] : []));
    expect(statuses).toContain('rejected');
  });

  it('timeout -> needs_human: the hirer decides; denial counts as a failure and asks for a revision', async () => {
    const hang: RubricJudge = (req) => new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    const { h, id } = await placedWith(scripted(hang));
    vi.mocked(h.gate.request).mockImplementation(async (req) => {
      h.asked.push(req.action);
      if (req.action === 'accept') return { approved: false, approval: { status: 'denied', note: 'colours are wrong', decidedBy: 'hirer' } as never };
      return { approved: true };
    });
    await h.svc.deliver(id, { text: 'the final logo' });
    await vi.waitFor(() => expect(h.status(id)).toBe('in_revision'), { timeout: 3000 });
    const [first, human] = h.svc.verifications(id);
    expect(first).toMatchObject({ verdict: 'needs_human' });
    expect(first!.checks.at(-1)!.detail).toMatch(/timed out/);
    expect(human).toMatchObject({ verdict: 'fail' });
    expect(human!.checks.at(-1)).toMatchObject({ name: 'hirer_review', by: 'human', detail: 'colours are wrong' });
    expect(h.escrow.release).not.toHaveBeenCalled();
  });

  it('LLM unavailable -> needs_human: nothing is released until a person approves', async () => {
    const { h, id } = await placedWith(scripted(async () => { throw new Error('529 overloaded'); }));
    let approve!: (v: { approved: boolean }) => void;
    vi.mocked(h.gate.request).mockImplementation(async (req) => {
      h.asked.push(req.action);
      return req.action === 'accept' ? new Promise((r) => { approve = r; }) : { approved: true };
    });
    await h.svc.deliver(id, { text: 'the final logo' });
    await vi.waitFor(() => expect(h.asked).toContain('accept'));
    expect(h.status(id)).toBe('delivered');
    expect(h.store.getBooking(id)?.verification?.verdict).toBe('needs_human');
    expect(h.escrow.release).not.toHaveBeenCalled();
    approve({ approved: true });
    await vi.waitFor(() => expect(h.status(id)).toBe('completed'));
    expect(h.store.getEscrowByBooking(id)?.status).toBe('released');
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

describe('settling races', () => {
  const MIN = 60_000;
  async function placed(o: Opts = {}) {
    const h = setup(o);
    const b = h.svc.create(job, cand(50));
    await vi.waitFor(() => expect(h.status(b.id)).toBe('placed'));
    return { h, id: b.id };
  }
  const gated = () => {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  };

  it('two concurrent accepts pay and release once', async () => {
    const { h, id } = await placed();
    const g = gated();
    vi.mocked(h.source.acceptDelivery!).mockImplementation(() => g.p);
    const a = h.svc.accept(id);
    const b = h.svc.accept(id);
    await vi.waitFor(() => expect(h.source.acceptDelivery).toHaveBeenCalled());
    g.open();
    await Promise.all([a, b]);
    expect(h.source.acceptDelivery).toHaveBeenCalledTimes(1);
    expect(h.escrow.release).toHaveBeenCalledTimes(1);
    expect(h.status(id)).toBe('completed');
  });

  it('a cancel or a deadline expiry while the accept pays out does not refund it', async () => {
    const { h, id } = await placed({ config: { ESCROW_DEADLINE_MIN: 60 } });
    const g = gated();
    vi.mocked(h.source.acceptDelivery!).mockImplementation(() => g.p);
    const accepting = h.svc.accept(id);
    await vi.waitFor(() => expect(h.source.acceptDelivery).toHaveBeenCalled());
    await h.svc.cancel(id, 'changed my mind');
    h.clock.t += 61 * MIN;
    await h.svc.tick();
    g.open();
    await accepting;
    expect(h.escrow.refund).not.toHaveBeenCalled();
    expect(h.status(id)).toBe('completed');
  });

  it('refuses an accept inside the release margin, and never retries a release past the deadline', async () => {
    const { h, id } = await placed({ config: { ESCROW_DEADLINE_MIN: 60 } });
    h.clock.t += 59 * MIN;
    await expect(h.svc.accept(id)).rejects.toThrow(/deadline/);
    expect(h.source.acceptDelivery).not.toHaveBeenCalled();

    // A completed booking whose release failed: past the deadline tick re-reads the chain instead.
    const { h: h2, id: id2 } = await placed({ config: { ESCROW_DEADLINE_MIN: 60 } });
    vi.mocked(h2.escrow.release).mockRejectedValueOnce(new Error('rpc down'));
    await h2.svc.accept(id2);
    expect(h2.store.getEscrowByBooking(id2)?.status).toBe('funded');
    h2.clock.t += 61 * MIN;
    await h2.svc.tick();
    await h2.svc.tick();
    expect(h2.escrow.release).toHaveBeenCalledTimes(1);
    expect(h2.escrow.refresh).toHaveBeenCalled();
  });

  it('a cancel and tick together refund once', async () => {
    const { h, id } = await placed();
    const g = gated();
    vi.mocked(h.escrow.refund).mockImplementation(async (e) => (await g.p, { ...e, status: 'refunded' as const }));
    const cancelling = h.svc.cancel(id, 'bye');
    await vi.waitFor(() => expect(h.escrow.refund).toHaveBeenCalled());
    await h.svc.tick();
    g.open();
    await cancelling;
    expect(h.escrow.refund).toHaveBeenCalledTimes(1);
    expect(h.status(id)).toBe('refunded');
    expect(h.store.getBooking(id)?.note).toBe('bye');
  });

  it('a delivery pushed while QA judges the previous one waits for the verdict', async () => {
    let finish!: (r: Awaited<ReturnType<ResultVerifier['verify']>>) => void;
    const verifier: ResultVerifier = { verify: vi.fn(() => new Promise<Awaited<ReturnType<ResultVerifier['verify']>>>((r) => (finish = r))) };
    const { h, id } = await placed({ verifier });
    await h.svc.deliver(id, { text: 'v1' });
    await vi.waitFor(() => expect(h.status(id)).toBe('verifying'));
    await h.svc.deliver(id, { text: 'v2' });
    expect(h.status(id)).toBe('verifying');
    expect(h.svc.delivery(id)).toEqual({ text: 'v1' });
    finish({ verdict: 'fail', score: 0, checks: [], summary: 'no', resultHash: 'r', deliveryHash: 'd1', attempt: 1, ms: 1, at: 1 });
    await vi.waitFor(() => expect(h.status(id)).toBe('in_revision'));
  });
});
