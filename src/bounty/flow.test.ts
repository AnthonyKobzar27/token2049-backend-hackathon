import { afterEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import { createDemoStack, type DemoStack } from './demo';
import { TEAM } from './seed';

// The demo story end to end, over HTTP: MIP-003 start_job -> check-in -> bounty posted ->
// worker claims and submits on /w/:token -> QA -> accept -> payout -> /status result.

const thisThursday = (now = Date.now()) => {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + ((4 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
};

let stack: DemoStack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

async function boot() {
  const paid: string[] = [];
  stack = createDemoStack({
    config: testConfig({ PUBLIC_URL: 'http://demo.test' }),
    workers: TEAM,
    log: () => {},
    payout: { pay: async (w, b) => (paid.push(`${w.id}:${b.reward.amount}${b.reward.currency}`), { chain: 'solana', address: w.wallets.solana, ref: 'tx_demo' }) },
  });
  const base = await stack.listen(0);
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, body === undefined ? { headers: { accept: 'application/json' } } : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { s: stack, base, call, paid };
}

const statusOf = async (call: Awaited<ReturnType<typeof boot>>['call'], id: string, want: string) =>
  vi.waitFor(
    async () => {
      const r = await call(`/status?job_id=${id}`);
      expect(r.body.status).toBe(want);
      return r.body;
    },
    { timeout: 3000, interval: 20 },
  );

describe('demo story: book a physio slot through a bounty', () => {
  it('goes from start_job to "Booked: Thursday 3pm, ref 88213"', async () => {
    const { s, call, paid } = await boot();
    const start = await call('/start_job', { input_data: { task: 'Call Tanjong Pagar Polyclinic and book the earliest physio slot this week', location: 'Singapore', budget_usd: 5 } });
    expect(start.status).toBe(200);
    const jobId = start.body.id as string;

    const checkIn = await statusOf(call, jobId, 'awaiting_input');
    const ids = (checkIn.shortlist as { id: string }[]).map((c) => c.id);
    expect(ids[0]).toBe('bounty:w_nithya'); // nearest verified teammate first
    expect(ids).not.toContain('bounty:w_priya'); // unverified

    expect((await call('/provide_input', { job_id: jobId, input_data: { choice: 'bounty:w_nithya' } })).status).toBe(200);
    const bounty = await vi.waitFor(() => {
      const b = s.bounty.board.list()[0];
      expect(b?.status).toBe('posted');
      return b!;
    });
    expect(bounty.spec.title).toBe('Phone call, ~5 min, book a physio slot, S$3');
    const token = bounty.offers.find((o) => o.workerId === 'w_nithya')!.token;

    const page = await call(`/w/${token}`);
    expect(page.body).toMatchObject({ status: 'posted', title: bounty.spec.title });
    expect((await call(`/w/${token}/claim`, {})).body).toMatchObject({ ok: true, bounty: { status: 'claimed' } });
    const date = thisThursday();
    const sub = await call(`/w/${token}/submit`, { date, time: '15:00', reference: '88213', notes: 'Bring NRIC' });
    expect(sub.body).toMatchObject({ ok: true, bounty: { status: 'submitted' } });

    const done = await statusOf(call, jobId, 'completed');
    const result = JSON.parse(done.result as string);
    expect(result.outcome).toBe('booked');
    expect(result.summary).toMatch(/^Booked: \w+day 3pm, ref 88213$/);
    expect(result.work.data).toMatchObject({ date, time: '15:00', reference: '88213', notes: 'Bring NRIC' });
    expect(paid).toEqual(['w_nithya:3SGD']);
    expect(s.bounty.board.get(bounty.id)).toMatchObject({ status: 'paid', qa: { ok: true, by: 'rules' } });
    const booking = s.store.getBooking(result.bookingId)!;
    expect(booking.status).toBe('completed');
    expect(s.store.getEscrowByBooking(booking.id)?.status).toBe('released');
  });

  it('sends a failing submission back to the worker, then accepts the fix', async () => {
    const { s, call } = await boot();
    const start = await call('/start_job', { input_data: { task: 'Call Tanjong Pagar Polyclinic and book the earliest physio slot this week', location: 'Singapore' } });
    const jobId = start.body.id as string;
    await statusOf(call, jobId, 'awaiting_input');
    await call('/provide_input', { job_id: jobId, input_data: { choice: 'bounty:w_oliver' } });
    const b = await vi.waitFor(() => {
      const x = s.bounty.board.list()[0];
      expect(x?.status).toBe('posted');
      return x!;
    });
    const token = b.offers.find((o) => o.workerId === 'w_oliver')!.token;
    await call(`/w/${token}/claim`, {});
    await call(`/w/${token}/submit`, { date: '2020-01-02', time: '15:00', reference: '88213' });
    await vi.waitFor(() => expect(s.bounty.board.get(b.id)).toMatchObject({ status: 'claimed', revisions: 1, feedback: expect.stringMatching(/in the past/) }));
    expect((await statusOf(call, jobId, 'running')).result).toBeUndefined();

    await call(`/w/${token}/submit`, { date: thisThursday(), time: '9:30', reference: 'TPP-1' });
    const done = await statusOf(call, jobId, 'completed');
    expect(JSON.parse(done.result as string).summary).toMatch(/9:30am, ref TPP-1$/);
  });

  it('refunds the escrow when nobody claims in time', async () => {
    const { s, call } = await boot();
    const start = await call('/start_job', { input_data: { task: 'Call Tanjong Pagar Polyclinic and book the earliest physio slot this week', location: 'Singapore' } });
    const jobId = start.body.id as string;
    await statusOf(call, jobId, 'awaiting_input');
    await call('/provide_input', { job_id: jobId, input_data: { choice: 'bounty:w_nithya' } });
    const b = await vi.waitFor(() => {
      const x = s.bounty.board.list()[0];
      expect(x?.status).toBe('posted');
      return x!;
    });
    vi.spyOn(Date, 'now').mockReturnValue(b.claimBy + 1);
    await s.bounty.tick();
    vi.restoreAllMocks();
    expect(s.bounty.board.get(b.id)?.status).toBe('expired');
    await s.bookings.tick();
    expect(s.store.listBookings()[0]).toMatchObject({ status: 'refunded' });
  });

  it('refuses a CAPTCHA-solving brief: no bounty worker is offered', async () => {
    const { s, call } = await boot();
    const start = await call('/start_job', { input_data: { task: 'Call me and solve the reCAPTCHA on the ticket site for me', location: 'Singapore' } });
    const jobId = start.body.id as string;
    await vi.waitFor(async () => expect(['awaiting_input', 'completed', 'failed']).toContain((await call(`/status?job_id=${jobId}`)).body.status));
    const st = (await call(`/status?job_id=${jobId}`)).body;
    expect(JSON.stringify(st.shortlist ?? [])).not.toContain('bounty:');
    expect(s.bounty.board.list()).toEqual([]);
  });
});
