import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { createEventBus } from '../domain/events';
import type { ApiDeps, JobService, Store } from '../domain/ports';
import type { Candidate, Job, Shortlist, UserInput } from '../domain/types';
import { mountMasumi } from './api';
import { inputHash, resultHash, schemaHash } from './hash';
import { createPaymentClient, defaultTimes } from './payments';
import { USDM_PREPROD_UNIT } from './pricing';
import { checkInSchema } from './schema';
import { verifySignature } from './signing';
import { createWatcher } from './watcher';

// ------------------------------------------------------------------ fakes

const cand = (id: string): Candidate => ({
  profile: { id, platform: 'fake', platformId: id, url: `https://x/${id}`, name: `N ${id}`, headline: 'h', skills: [], pricing: [], fetchedAt: 0 },
  score: 88,
  subscores: { suitability: null, price: null, rating: null, availability: null, speed: null },
  reason: 'good fit',
  unknowns: ['hours per week'],
  quoteUsd: 100,
});

function fakes() {
  const jobsById = new Map<string, Job>();
  const kv = new Map<string, string>();
  const calls = { markPaid: [] as string[], input: [] as [string, UserInput][] };
  let n = 0;
  const shortlist = (jobId: string): Shortlist => ({ id: 's1', jobId, round: 1, candidates: [cand('fake:1'), cand('fake:2')], sources: [], createdAt: 0 });
  const store = {
    getJob: (id) => jobsById.get(id) ?? null,
    updateJob: (id, patch) => {
      const j = jobsById.get(id);
      if (!j) throw new Error('missing');
      const next = { ...j, ...patch, updatedAt: Date.now() };
      jobsById.set(id, next);
      return next;
    },
    listJobs: (f) => [...jobsById.values()].filter((j) => (!f?.status || j.status === f.status) && (!f?.client || j.client === f.client)),
    getKv: (k) => kv.get(k) ?? null,
    setKv: (k, v) => void kv.set(k, v),
  } as Partial<Store> as Store;
  const jobs: JobService = {
    startJob: ({ brief, client, awaitPayment, id }) => {
      const j: Job = { id: id ?? `job_${++n}`, status: awaitPayment ? 'awaiting_payment' : 'running', client, brief, round: 1, createdAt: 0, updatedAt: 0 };
      jobsById.set(j.id, j);
      return j;
    },
    markPaid: (id) => {
      calls.markPaid.push(id);
      store.updateJob(id, { status: 'running' });
    },
    getJob: (id) => jobsById.get(id) ?? null,
    getShortlist: (id) => (jobsById.get(id)?.status === 'awaiting_input' ? shortlist(id) : null),
    provideInput: (id, input) => {
      calls.input.push([id, input]);
      if (input.action === 'confirm' && input.profileId === 'fake:boom') throw new Error('boom');
      return store.updateJob(id, { status: 'running' });
    },
    tick: async () => {},
  };
  return { store, jobs, calls, jobsById };
}

/** A stand-in for the payment service on localhost. Dynamic V2 source at index 0 unless told otherwise. */
async function fakePaymentService(opts: { pricingType?: string } = {}) {
  const log: { path: string; body: any; token?: string }[] = [];
  const state = {
    onChainState: null as string | null,
    nextAction: 'None',
    resultHash: null as string | null,
    history: [] as { txHash: string; status: string; newOnChainState: string }[],
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    log.push({ path: req.path, body: req.body, token: req.header('token') });
    next();
  });
  app.get('/registry/agent-identifier', (_req, res) =>
    res.json({
      status: 'success',
      data: {
        supportedPaymentSources: [
          { chain: 'Cardano', network: 'Preprod', paymentSourceType: 'Web3CardanoV2', address: 'addr_test1contract', pricing: { pricingType: opts.pricingType ?? 'Dynamic' } },
        ],
      },
    }),
  );
  app.post('/payment', (req, res) => {
    const b = req.body;
    res.json({
      status: 'success',
      data: {
        blockchainIdentifier: 'bc_1',
        payByTime: String(Date.parse(b.payByTime)),
        submitResultTime: String(Date.parse(b.submitResultTime)),
        unlockTime: String(Date.parse(b.unlockTime)),
        externalDisputeUnlockTime: String(Date.parse(b.externalDisputeUnlockTime)),
        onChainState: null,
        RequestedFunds: b.RequestedFunds ?? [],
        PaymentSource: { network: 'Preprod', paymentSourceType: 'Web3CardanoV2', smartContractAddress: 'addr_test1contract', policyId: 'p'.repeat(56) },
        SmartContractWallet: { walletVkey: 'vkey_seller', walletAddress: 'addr' },
        NextAction: { requestedAction: 'WaitingForExternalAction', errorType: null },
      },
    });
  });
  app.post('/payment/resolve-blockchain-identifier', (_req, res) =>
    res.json({
      status: 'success',
      data: {
        blockchainIdentifier: 'bc_1',
        onChainState: state.onChainState,
        resultHash: state.resultHash,
        NextAction: { requestedAction: state.nextAction, errorType: null },
        CurrentTransaction: state.history.at(-1) ?? null,
        TransactionHistory: state.history,
      },
    }),
  );
  app.post('/payment/submit-result', (req, res) => {
    state.nextAction = 'SubmitResultRequested';
    state.resultHash = req.body.submitResultHash;
    res.json({ status: 'success', data: { blockchainIdentifier: 'bc_1' } });
  });
  const server = await listen(app);
  return { url: `http://127.0.0.1:${port(server)}`, log, state, server };
}

const servers: Server[] = [];
const listen = (app: express.Express) =>
  new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    servers.push(s);
  });
const port = (s: Server) => (s.address() as AddressInfo).port;
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function boot(config = testConfig()) {
  const f = fakes();
  const bus = createEventBus();
  const deps: ApiDeps = { jobs: f.jobs, store: f.store, bus, config };
  const app = express();
  const handle = mountMasumi(app, deps);
  const server = await listen(app);
  const base = `http://127.0.0.1:${port(server)}`;
  const req = async (method: string, path: string, body?: unknown, raw?: string) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { ...f, req, handle, deps, bus };
}

const paidConfig = (url: string, extra: Parameters<typeof testConfig>[0] = {}) =>
  testConfig({ MASUMI_API_URL: url, MASUMI_API_KEY: 'k', MASUMI_AGENT_IDENTIFIER: 'agent'.padEnd(60, 'a'), ...extra });

// ------------------------------------------------------------------ tests

describe('MIP-003 routes, unpaid mode', () => {
  it('availability, input_schema and demo', async () => {
    const { req } = await boot();
    expect((await req('GET', '/availability')).body).toEqual({ status: 'available', type: 'masumi-agent', message: expect.any(String) });
    const schema = (await req('GET', '/input_schema')).body;
    expect(Object.keys(schema)).toEqual(['input_data']);
    expect(schema.input_data.map((f: any) => f.id)).toEqual(['task', 'skills', 'budget_usd', 'deadline_days', 'location', 'remote_ok', 'hours_needed', 'language', 'timezone', 'notes', 'when', 'radius_km', 'task_type']);
    for (const f of schema.input_data) expect(['string', 'number', 'boolean', 'option', 'none']).toContain(f.type);
    const demo = (await req('GET', '/demo')).body;
    expect(demo.input.task).toEqual(expect.any(String));
    expect(typeof demo.output.result).toBe('string');
    expect(JSON.parse(demo.output.result).outcome).toBe('booked');
  });

  it('start_job starts at once and returns a well-formed response with job_id and status', async () => {
    const { req, jobsById } = await boot();
    const r = await req('POST', '/start_job', { identifier_from_purchaser: 'my-id', input_data: { task: 'Logo', skills: 'figma' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ job_id: r.body.id, status: 'success', blockchainIdentifier: `free_${r.body.id}`, sellerVKey: '', identifierFromPurchaser: 'my-id', payment_required: false });
    for (const k of ['id', 'blockchainIdentifier', 'payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime', 'agentIdentifier', 'sellerVKey', 'identifierFromPurchaser', 'input_hash']) {
      expect(r.body).toHaveProperty(k);
    }
    expect(r.body.input_hash).toBe(inputHash({ task: 'Logo', skills: 'figma' }, 'my-id'));
    expect(jobsById.get(r.body.id)?.status).toBe('running');
    expect((await req('GET', `/status?job_id=${r.body.id}`)).body).toEqual({ job_id: r.body.id, status: 'running' });
  });

  it('rejects bad requests without crashing', async () => {
    const { req } = await boot();
    expect((await req('POST', '/start_job', { input_data: {} })).status).toBe(400);
    expect((await req('POST', '/start_job', undefined, '{nope')).status).toBe(400);
    expect((await req('POST', '/start_job', undefined, '[1,2]')).status).toBe(400);
    expect((await req('GET', '/status')).status).toBe(400);
    expect((await req('GET', '/status?job_id=zzz')).status).toBe(404);
    expect((await req('POST', '/provide_input', { job_id: 'zzz', input_data: {} })).status).toBe(404);
    expect((await req('POST', '/provide_input', { input_data: {} })).status).toBe(400);
    expect((await req('GET', '/availability')).status).toBe(200);
  });

  it('check-in flow: input_schema_hash is verified and the response is signed', async () => {
    const { req, jobsById, calls, store } = await boot();
    const { body } = await req('POST', '/start_job', { identifier_from_purchaser: 'ifp-1', input_data: { task: 'Logo' } });
    const id = body.id as string;

    let r = await req('POST', '/provide_input', { job_id: id, input_data: { choice: 'fake:1' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not awaiting_input/);

    store.updateJob(id, { status: 'awaiting_input' });
    const st = (await req('GET', `/status?job_id=${id}`)).body;
    expect(st.status).toBe('awaiting_input');
    expect(st.job_id).toBe(id);
    expect(st.input_schema.input_data[0].data.values).toHaveLength(4);
    expect(JSON.parse(st.result).candidates[0]).toMatchObject({ id: 'fake:1', score: 88, reason: 'good fit', unknowns: ['hours per week'], quote_usd: 100, url: 'https://x/fake:1' });
    // The client hashes exactly the object it received.
    const h = schemaHash(st.input_schema);
    expect(h).toBe(schemaHash(checkInSchema({ id: 's1', jobId: id, round: 1, candidates: [cand('fake:1'), cand('fake:2')], sources: [], createdAt: 0 })));

    r = await req('POST', '/provide_input', { job_id: id, input_data: { choice: st.input_schema.input_data[0].data.values[1] } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/input_schema_hash is required/);
    r = await req('POST', '/provide_input', { job_id: id, input_schema_hash: 'x', input_data: { choice: 'fake:1' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/does not match/);
    r = await req('POST', '/provide_input', { job_id: id, input_schema_hash: schemaHash(BRIEF), input_data: { choice: 'fake:1' } });
    expect(r.status).toBe(400);
    r = await req('POST', '/provide_input', { job_id: id, input_schema_hash: h, input_data: { choice: 'fake:99' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/unknown candidate/);
    expect(calls.input).toHaveLength(0);

    const input_data = { choice: st.input_schema.input_data[0].data.values[1] };
    r = await req('POST', '/provide_input', { job_id: id, input_schema_hash: h.toUpperCase(), input_data });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ input_hash: inputHash(input_data, 'ifp-1'), signature: expect.stringMatching(/^[0-9a-f]{128}$/) });
    expect(calls.input).toEqual([[id, { action: 'confirm', profileId: 'fake:2' }]]);
    const key = (await req('GET', '/signing_key')).body;
    expect(key).toMatchObject({ algorithm: 'Ed25519', public_key: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(verifySignature(r.body.input_hash, r.body.signature, key.public_key)).toBe(true);
    expect(verifySignature('0'.repeat(64), r.body.signature, key.public_key)).toBe(false);

    store.updateJob(id, { status: 'awaiting_input' });
    r = await req('POST', '/provide_input', { job_id: id, input_schema_hash: h, input_data: { choice: 'fake:boom' } });
    expect(r.status).toBe(400); // unknown candidate, caught before the service
    expect(jobsById.get(id)?.status).toBe('awaiting_input');
  });

  it('accepts a missing input_schema_hash only in lenient mode, never a wrong one', async () => {
    const { req, store } = await boot(testConfig({ MASUMI_LENIENT_SCHEMA_HASH: true }));
    const id = (await req('POST', '/start_job', { input_data: { task: 'Logo' } })).body.id;
    store.updateJob(id, { status: 'awaiting_input' });
    expect((await req('POST', '/provide_input', { job_id: id, input_schema_hash: 'f'.repeat(64), input_data: { choice: 'fake:1' } })).status).toBe(400);
    expect((await req('POST', '/provide_input', { job_id: id, input_data: { choice: 'fake:1' } })).status).toBe(200);
  });

  it('signs with the configured key', async () => {
    const seed = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'; // RFC 8032 test 1
    const { req } = await boot(testConfig({ MASUMI_SIGNING_KEY: seed }));
    expect((await req('GET', '/signing_key')).body.public_key).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  });

  it('exposes the result as a string when completed', async () => {
    const { req, store } = await boot();
    const id = (await req('POST', '/start_job', { input_data: { task: 'Logo' } })).body.id;
    store.updateJob(id, { status: 'completed', result: { outcome: 'booked', summary: 'done', priceUsd: 100 } });
    const st = (await req('GET', `/status?job_id=${id}`)).body;
    expect(typeof st.result).toBe('string');
    expect(JSON.parse(st.result)).toMatchObject({ outcome: 'booked', priceUsd: 100 });
  });
});

const BRIEF = { input_data: [] };

describe('paid mode', () => {
  it('start_job is idempotent per identifier_from_purchaser and input: retries never start a second job or payment', async () => {
    const ps = await fakePaymentService();
    const { req, jobsById } = await boot(paidConfig(ps.url));
    const body = { identifier_from_purchaser: 'abcdef0123456789abcd', input_data: { task: 'Logo' } };
    const [a, b] = await Promise.all([req('POST', '/start_job', body), req('POST', '/start_job', body)]);
    const c = await req('POST', '/start_job', body);
    expect(b.body).toEqual(a.body);
    expect(c.body).toEqual(a.body);
    expect(ps.log.filter((l) => l.path === '/payment')).toHaveLength(1);
    expect(jobsById.size).toBe(1);
    const other = await req('POST', '/start_job', { ...body, input_data: { task: 'Website' } });
    expect(other.body.job_id).not.toBe(a.body.job_id);
    expect(jobsById.size).toBe(2);
  });

  it('Dynamic USDM payment, funds lock, result hash once, collection after unlock', async () => {
    const ps = await fakePaymentService();
    const config = paidConfig(ps.url);
    const { req, jobsById, calls, store, handle, deps } = await boot(config);

    const ifp = 'abcdef0123456789abcd';
    const r = await req('POST', '/start_job', { identifier_from_purchaser: ifp, input_data: { task: 'Logo' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      job_id: r.body.id,
      status: 'success',
      blockchainIdentifier: 'bc_1',
      sellerVKey: 'vkey_seller',
      identifierFromPurchaser: ifp,
      payment_required: true,
      amounts: [{ amount: '1000000', unit: USDM_PREPROD_UNIT }],
      price: '1 USDM',
      paymentSourceType: 'Web3CardanoV2',
      supportedPaymentSourceIndex: 0,
      smartContractAddress: 'addr_test1contract',
    });
    expect(r.body.payByTime).toBeLessThan(r.body.submitResultTime);
    expect(r.body.submitResultTime).toBeLessThan(r.body.unlockTime);
    expect(r.body.unlockTime).toBeLessThan(r.body.externalDisputeUnlockTime);
    // Result window: 90 min by default, an hour of it for the human check-in; unlock 16 min after it.
    expect(r.body.submitResultTime - Date.now()).toBeGreaterThan(89 * 60_000);
    expect(r.body.unlockTime - r.body.submitResultTime).toBe(16 * 60_000);

    const created = ps.log.find((l) => l.path === '/payment')!;
    expect(created.token).toBe('k');
    expect(created.body).toMatchObject({
      network: 'Preprod',
      agentIdentifier: config.MASUMI_AGENT_IDENTIFIER,
      identifierFromPurchaser: ifp,
      inputHash: r.body.input_hash,
      paymentSourceType: 'Web3CardanoV2',
      supportedPaymentSourceIndex: 0,
      RequestedFunds: [{ amount: '1000000', unit: USDM_PREPROD_UNIT }],
      metadata: JSON.stringify({ haasJobId: r.body.id }),
    });
    expect(created.body.payByTime).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(jobsById.get(r.body.id)).toMatchObject({ status: 'awaiting_payment', payment: { blockchainIdentifier: 'bc_1' } });

    expect((await req('POST', '/start_job', { identifier_from_purchaser: 'not hex!', input_data: { task: 'x' } })).status).toBe(400);

    const watcher = createWatcher(deps, createPaymentClient(config));
    await watcher.poll();
    expect(calls.markPaid).toEqual([]); // unpaid
    ps.state.onChainState = 'FundsLocked';
    await watcher.poll();
    expect(calls.markPaid).toEqual([r.body.id]);
    expect(jobsById.get(r.body.id)?.payment?.paidAt).toBeTypeOf('number');

    const done = store.updateJob(r.body.id, { status: 'completed', result: { outcome: 'no_booking', summary: 'cancelled' } });
    await watcher.poll();
    await watcher.poll();
    const submits = ps.log.filter((l) => l.path === '/payment/submit-result');
    expect(submits).toHaveLength(1);
    const hash = resultHash(JSON.stringify(done.result), ifp);
    expect(submits[0]!.body).toEqual({ network: 'Preprod', blockchainIdentifier: 'bc_1', submitResultHash: hash });
    expect(jobsById.get(r.body.id)?.payment).toMatchObject({ resultSubmittedAt: expect.any(Number), resultHash: hash });
    expect((await req('GET', `/status?job_id=${r.body.id}`)).body.result).toBe(JSON.stringify(done.result));

    // Collection: nothing before unlockTime; after it, the confirmed Withdrawn tx is recorded.
    ps.state.onChainState = 'ResultSubmitted';
    const unlock = jobsById.get(r.body.id)!.payment!.unlockTime;
    const later = createWatcher(deps, createPaymentClient(config), { now: () => unlock + 60_000 });
    const resolvesBefore = ps.log.filter((l) => l.path === '/payment/resolve-blockchain-identifier').length;
    await watcher.poll();
    expect(ps.log.filter((l) => l.path === '/payment/resolve-blockchain-identifier').length).toBe(resolvesBefore);
    await later.poll();
    expect(jobsById.get(r.body.id)?.payment?.collectionTxHash).toBeUndefined();
    ps.state.onChainState = 'Withdrawn';
    ps.state.history = [
      { txHash: 'a'.repeat(64), status: 'Confirmed', newOnChainState: 'ResultSubmitted' },
      { txHash: 'c'.repeat(64), status: 'Pending', newOnChainState: 'Withdrawn' },
    ];
    await later.poll();
    expect(jobsById.get(r.body.id)?.payment?.collectionTxHash).toBeUndefined(); // not confirmed yet
    ps.state.history[1]!.status = 'Confirmed';
    await later.poll();
    expect(jobsById.get(r.body.id)?.payment).toMatchObject({ collectionTxHash: 'c'.repeat(64), onChainState: 'Withdrawn', collectedAt: expect.any(Number) });
    const st = (await req('GET', `/status?job_id=${r.body.id}`)).body;
    expect(st.payment).toMatchObject({ collection_tx_hash: 'c'.repeat(64), result_hash: hash, onChainState: 'Withdrawn' });
    expect(st.result).toBe(JSON.stringify(done.result)); // unchanged after collection
    handle.stop();
  });

  it('quotes a share of the budget when MASUMI_FEE_PERCENT is set', async () => {
    const ps = await fakePaymentService();
    const { req } = await boot(paidConfig(ps.url, { MASUMI_FEE_PERCENT: 2 }));
    const r = await req('POST', '/start_job', { identifier_from_purchaser: 'abcdef0123456789abcd', input_data: { task: 'Logo', budget_usd: 250 } });
    expect(r.body.amounts).toEqual([{ amount: '6000000', unit: USDM_PREPROD_UNIT }]); // 1 + 2% of 250
  });

  it('sends no RequestedFunds when the registered source is Fixed', async () => {
    const ps = await fakePaymentService({ pricingType: 'Fixed' });
    const { req } = await boot(paidConfig(ps.url));
    expect((await req('POST', '/start_job', { identifier_from_purchaser: 'abcdef0123456789abcd', input_data: { task: 'Logo' } })).status).toBe(200);
    expect(ps.log.find((l) => l.path === '/payment')!.body.RequestedFunds).toBeUndefined();
  });

  it('fails jobs that were not paid by payByTime', async () => {
    const ps = await fakePaymentService();
    const config = paidConfig(ps.url);
    const { req, jobsById, deps } = await boot(config);
    const r = await req('POST', '/start_job', { identifier_from_purchaser: 'abcdef0123456789abcd', input_data: { task: 'Logo' } });
    const watcher = createWatcher(deps, createPaymentClient(config), { now: () => r.body.payByTime + 1 });
    await watcher.poll();
    expect(jobsById.get(r.body.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/payByTime/) });
  });

  it('answers 500 when the payment service is down', async () => {
    const { req, jobsById } = await boot(paidConfig('http://127.0.0.1:1'));
    const r = await req('POST', '/start_job', { identifier_from_purchaser: 'abcdef0123456789abcd', input_data: { task: 'Logo' } });
    expect(r.status).toBe(500);
    expect(jobsById.size).toBe(0);
  });
});

describe('payment deadlines', () => {
  it('meet the payment service limits for any window', () => {
    const now = 1_000_000;
    for (const w of [
      { payMin: 60, resultMin: 480, unlockDelayMin: 20, disputeDelayMin: 20 },
      { payMin: 0, resultMin: 0, unlockDelayMin: 0, disputeDelayMin: 0 },
      { payMin: 600, resultMin: 30, unlockDelayMin: 15, disputeDelayMin: 15 },
    ]) {
      const t = defaultTimes(now, w);
      const min = 60_000;
      expect(t.submitResultTime).toBeGreaterThanOrEqual(now + 15 * min);
      expect(t.payByTime).toBeLessThanOrEqual(t.submitResultTime - 5 * min);
      expect(t.payByTime).toBeGreaterThan(now);
      expect(t.unlockTime).toBeGreaterThanOrEqual(t.submitResultTime + 15 * min);
      expect(t.externalDisputeUnlockTime).toBeGreaterThanOrEqual(t.unlockTime + 15 * min);
    }
  });
});
