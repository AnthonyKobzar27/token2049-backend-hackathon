// End to end, through the MIP-003 API: the clinic-booking story from a paid Masumi job to a verified,
// paid, reputation-minted result; the AI-agent path; a rejected delivery (no payout); a timeout refund.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEAM } from '../bounty/seed';
import { inputHash, resultHash, schemaHash } from '../masumi/hash';
import { fakeSeller, type Fake } from '../masumi/__fixtures__/fake-seller';
import { createPaymentClient } from '../masumi/payments';
import { verifySignature } from '../masumi/signing';
import { createWatcher } from '../masumi/watcher';
import { fakeAid } from '../identity/veridian/fake';
import type { RubricJudge } from '../verify/rubric';
import { closeAll, createPitchStack, fakeSellerPayments } from './stack';

const TASK = 'Call Tanjong Pagar Polyclinic and book the earliest physio slot this week';
const IFP = 'a1b2c3d4e5f60718293a';
/** Real base58 key so the escrow pays the worker directly in direct mode. */
const NITHYA_SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const NITHYA_ADA = 'addr_test1_nithya_wallet';
const team = TEAM.map((w) => (w.id === 'w_nithya' ? { ...w, wallets: { solana: NITHYA_SOL, cardano: NITHYA_ADA } } : { ...w, wallets: {} }));

const thisThursday = (now = Date.now()) => {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + ((4 - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
};

/** Stands in for the QA model: a delivery passes when it carries a booking reference. */
const rubric: RubricJudge = async (req) =>
  req.delivery.fields?.reference
    ? { verdict: 'pass', score: 0.95, checks: [{ name: 'booking', ok: true, detail: 'date, time and reference given' }], summary: 'Physio slot booked with a reference.' }
    : { verdict: 'fail', score: 0.1, checks: [{ name: 'booking', ok: false, detail: 'no booking reference' }], summary: 'No booking reference.' };
const neverPasses: RubricJudge = async () => ({ verdict: 'fail', score: 0.2, checks: [{ name: 'booking', ok: false, detail: 'the reference does not exist at the clinic' }], summary: 'The clinic has no such booking.' });

let stack: Awaited<ReturnType<typeof createPitchStack>> | undefined;
const fakes: Fake[] = [];
afterEach(async () => {
  stack?.stop();
  stack = undefined;
  await Promise.all(fakes.splice(0).map((f) => f.close()));
  await closeAll();
});

const until = <T>(fn: () => T | Promise<T>, timeout = 4000) => vi.waitFor(fn, { timeout, interval: 10 });
const statusOf = (s: NonNullable<typeof stack>, id: string, want: string) =>
  until(async () => {
    const r = await s.call(`/status?job_id=${id}`);
    expect(r.body.status).toBe(want);
    return r.body;
  });

/** start_job -> (paid) funds locked -> shortlist -> provide_input confirming `pick`. */
async function hireThroughMasumi(s: NonNullable<typeof stack>, pick = 'bounty:w_nithya', ps?: Awaited<ReturnType<typeof fakeSellerPayments>>) {
  const start = await s.call('/start_job', { identifier_from_purchaser: IFP, input_data: { task: TASK, location: 'Singapore', budget_usd: 5 } });
  expect(start.status).toBe(200);
  const jobId = start.body.job_id as string;
  if (ps) {
    expect(start.body).toMatchObject({ status: 'success', blockchainIdentifier: 'bc_1', payment_required: true });
    expect((await s.call(`/status?job_id=${jobId}`)).body.status).toBe('awaiting_payment');
    ps.state.onChainState = 'FundsLocked';
    await createWatcher({ jobs: s.jobs, store: s.store, bus: s.bus, config: s.config }, createPaymentClient(s.config)).poll();
  }
  const check = await statusOf(s, jobId, 'awaiting_input');
  const input_data = { choice: pick };
  const r = await s.call('/provide_input', { job_id: jobId, input_schema_hash: schemaHash(check.input_schema), input_data });
  expect(r.status).toBe(200);
  expect(r.body.input_hash).toBe(inputHash(input_data, IFP));
  const key = (await s.call('/signing_key')).body;
  expect(verifySignature(r.body.input_hash, r.body.signature, key.public_key)).toBe(true);
  const bounty = await until(() => {
    const b = s.bounty.board.list({ status: ['posted'] })[0];
    expect(b).toBeTruthy();
    return b!;
  });
  return { jobId, check, bounty };
}

async function claimAndSubmit(s: NonNullable<typeof stack>, bountyId: string, worker: string, fields: Record<string, string>) {
  const token = s.bounty.board.get(bountyId)!.offers.find((o) => o.workerId === worker)!.token;
  expect((await s.call(`/w/${token}/claim`, {})).body).toMatchObject({ ok: true });
  expect((await s.call(`/w/${token}/submit`, fields)).body).toMatchObject({ ok: true });
  return token;
}

describe('pitch flow, end to end over MIP-003', () => {
  it('clinic booking: paid job, AI says "needs a person", verified human, escrow, QA, release, reputation, result', async () => {
    const ps = await fakeSellerPayments();
    const aiAgent = await fakeSeller({ output: 'should not be hired' });
    fakes.push(aiAgent);
    stack = await createPitchStack({
      workers: team,
      rubric,
      config: { MASUMI_API_URL: ps.url, MASUMI_API_KEY: 'k', MASUMI_AGENT_IDENTIFIER: 'agent'.padEnd(60, 'a'), AI_AGENT_URL: aiAgent.url, BOUNTY_MODE: 'direct' },
    });
    const s = stack;

    // Nithya holds a Veridian "HAAS Verified Worker" credential (wallet onboarding, then a verify).
    const session = await s.veridian.start({ workerId: 'bounty:w_nithya', platformsVerified: ['haas-bounty'], verificationMethod: 'operator-kyc' });
    const granted = await s.veridian.connect(session.id, `http://wallet.test/oobi/${fakeAid('nithya')}/agent/${fakeAid('nithya-agent')}`);
    s.keria.deliver('/exn/ipex/admit', { i: fakeAid('nithya'), p: granted.grantSaid });
    expect((await s.veridian.verify({ workerId: 'bounty:w_nithya' })).valid).toBe(true);

    const { jobId, check, bounty } = await hireThroughMasumi(s, 'bounty:w_nithya', ps);
    // The AI step looked at the brief and handed it to the human router without hiring the agent.
    expect(aiAgent.log.filter((l) => l.path === '/start_job')).toHaveLength(0);
    const progress = s.events.flatMap((e) => (e.type === 'job.progress' && e.jobId === jobId ? [e.message] : []));
    expect(progress.some((m) => m.startsWith('This needs a person'))).toBe(true);
    // The shortlist ranks nearby verified humans and labels the credentialed one.
    const shortlist = JSON.parse(check.result).candidates as { id: string; verified: boolean; verified_by?: string[] }[];
    expect(shortlist[0]).toMatchObject({ id: 'bounty:w_nithya', verified: true, verified_by: ['veridian'] });
    expect(shortlist.find((c) => c.id !== 'bounty:w_nithya')?.verified).toBe(false);
    expect(check.input_schema.input_data[0].data.values[0]).toContain('✓ verified');

    // Escrow locked for the worker's wallet before the bounty went out.
    const booking = s.store.getBooking(s.store.getJob(jobId)!.bookingId!)!;
    expect(s.store.getEscrowByBooking(booking.id)).toMatchObject({ status: 'funded', payee: NITHYA_SOL, deadline: expect.any(Number) });
    expect(s.asked.map((a) => a.action)).toEqual(['book']);

    await claimAndSubmit(s, bounty.id, 'w_nithya', { date: thisThursday(), time: '15:00', reference: '88213' });
    const done = await statusOf(s, jobId, 'completed');
    const result = JSON.parse(done.result);
    expect(result).toMatchObject({ outcome: 'booked', path: 'human', summary: expect.stringMatching(/ref 88213$/), work: { data: { reference: '88213' } } });

    // One hash for the verified delivery: QA report, escrow release on Solana, the job result and the reputation receipt.
    const b = s.store.getBooking(booking.id)!;
    expect(b).toMatchObject({ status: 'completed', verification: { verdict: 'pass' } });
    const hash = b.resultHash!;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.verifiedResult.hash).toBe(hash);
    expect(resultHash(result.verifiedResult.payload, IFP)).toBe(hash); // a buyer can check it (MIP-004)
    expect(s.escrow.releases).toEqual([{ bookingId: booking.id, payee: NITHYA_SOL, resultHash: hash, amount: booking.priceUsd }]);
    expect(s.paid).toEqual(['w_nithya:3SGD']);
    expect(s.asked.map((a) => a.action)).toEqual(['book', 'accept']);

    // Masumi gets the MIP-004 hash of exactly the /status result, which names the release hash.
    await createWatcher({ jobs: s.jobs, store: s.store, bus: s.bus, config: s.config }, createPaymentClient(s.config)).poll();
    expect(ps.log.filter((l) => l.path === '/payment/submit-result').map((l) => l.body.submitResultHash)).toEqual([resultHash(done.result, IFP)]);

    await until(() => expect(s.identity.minter.task(booking.id)?.status).toBe('done'));
    const rep = s.identity.registry.reputationOf('bounty:w_nithya');
    expect(rep).toMatchObject({ jobsCompleted: 1, verifiedJobs: 1, lastResultHash: hash });
    expect(s.identity.registry.credentialOf('bounty:w_nithya')?.walletAddress).toBe(NITHYA_ADA);
  });

  it('AI path: a digital brief is done by a Masumi AI agent and returned with no human or escrow', async () => {
    const aiAgent = await fakeSeller({ output: '- Chang adds governance\n- Plutus V3', resultHash: 'good' });
    fakes.push(aiAgent);
    stack = await createPitchStack({ workers: team, rubric, config: { AI_AGENT_URL: aiAgent.url, AI_AGENT_NAME: 'Summariser' } });
    const s = stack;
    const start = await s.call('/start_job', { identifier_from_purchaser: IFP, input_data: { task: 'Summarise the Cardano Chang upgrade in five bullets' } });
    const done = await statusOf(s, start.body.job_id, 'completed');
    expect(JSON.parse(done.result)).toMatchObject({ outcome: 'delivered', path: 'ai', output: '- Chang adds governance\n- Plutus V3', agent: { name: 'Summariser', verified: true } });
    expect(s.store.listBookings({})).toHaveLength(0);
    expect(s.bounty.board.list()).toHaveLength(0);
  });

  it('rejected result: QA fails, one revision, fails again -> no payout, budget refunded, nothing minted', async () => {
    stack = await createPitchStack({ workers: team, rubric: neverPasses, config: { BOUNTY_MODE: 'direct' } });
    const s = stack;
    const { jobId, bounty } = await hireThroughMasumi(s);
    await claimAndSubmit(s, bounty.id, 'w_nithya', { date: thisThursday(), time: '15:00', reference: '11111' });
    // QA failed: the worker is asked for a revision and the bounty goes back to them.
    await until(() => expect(s.bounty.board.get(bounty.id)).toMatchObject({ status: 'claimed', revisions: 1 }));
    const token = s.bounty.board.get(bounty.id)!.offers.find((o) => o.workerId === 'w_nithya')!.token;
    expect((await s.call(`/w/${token}/submit`, { date: thisThursday(), time: '16:00', reference: '22222' })).body).toMatchObject({ ok: true });

    const done = await statusOf(s, jobId, 'completed');
    expect(JSON.parse(done.result)).toMatchObject({ outcome: 'no_booking', summary: expect.stringMatching(/^Booking ended \(rejected\): Rejected by QA: The clinic has no such booking\.$/) });
    await until(() => expect(s.store.getBooking(s.store.getJob(jobId)!.bookingId!)?.status).toBe('refunded'));
    const booking = s.store.getBooking(s.store.getJob(jobId)!.bookingId!)!;
    expect(booking.status).toBe('refunded');
    expect(s.events.some((e) => e.type === 'verification.rejected')).toBe(true);
    expect(s.escrow.releases).toEqual([]);
    expect(s.escrow.refunds).toEqual([{ bookingId: booking.id, amount: booking.priceUsd }]);
    expect(s.paid).toEqual([]);
    expect(s.asked.filter((a) => a.action === 'accept')).toEqual([]);
    expect(s.bounty.board.get(bounty.id)?.status).toBe('cancelled');
    expect(s.identity.minter.task(booking.id)).toBeUndefined();
  });

  it('timeout: nobody delivers before the escrow deadline -> automatic refund, the bounty is withdrawn', async () => {
    stack = await createPitchStack({ workers: team, rubric, config: { ESCROW_DEADLINE_MIN: 30 } });
    const s = stack;
    const { jobId, bounty } = await hireThroughMasumi(s);
    const booking = s.store.getBooking(s.store.getJob(jobId)!.bookingId!)!;
    s.clock.t += 29 * 60_000;
    await s.bookings.tick();
    expect(s.store.getBooking(booking.id)?.status).toBe('placed');
    s.clock.t += 2 * 60_000;
    await s.bookings.tick();

    expect(s.store.getBooking(booking.id)?.status).toBe('refunded');
    expect(s.escrow.refunds).toEqual([{ bookingId: booking.id, amount: booking.priceUsd }]);
    expect(s.events.find((e) => e.type === 'escrow.timeout')).toMatchObject({ kind: 'delivery_expired' });
    expect(s.bounty.board.get(bounty.id)?.status).toBe('cancelled');
    const done = await statusOf(s, jobId, 'completed');
    expect(JSON.parse(done.result).outcome).toBe('no_booking');
    // A late submission cannot pay out any more.
    const token = s.bounty.board.get(bounty.id)!.offers[0]!.token;
    expect((await s.call(`/w/${token}/claim`, {})).body.ok).toBe(false);
    expect(s.escrow.releases).toEqual([]);
    expect(s.paid).toEqual([]);
  });
});
