import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { createEventBus } from '../domain/events';
import type { ApiDeps, JobService, Store } from '../domain/ports';
import type { Candidate, Job, Shortlist, UserInput } from '../domain/types';
import { mountMasumi } from './api';
import { inputHash, resultHash } from './hash';
import { createPaymentClient } from './payments';
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
    startJob: ({ brief, client, awaitPayment }) => {
      const j: Job = { id: `job_${++n}`, status: awaitPayment ? 'awaiting_payment' : 'running', client, brief, round: 1, createdAt: 0, updatedAt: 0 };
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

/** A stand-in for the payment service on localhost. */
async function fakePaymentService() {
  const log: { path: string; body: any; token?: string }[] = [];
  const state = { onChainState: null as string | null, nextAction: 'None' };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    log.push({ path: req.path, body: req.body, token: req.header('token') });
    next();
  });
  app.get('/registry/agent-identifier', (_req, res) => res.json({ status: 'success', data: { supportedPaymentSources: [] } }));
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
        SmartContractWallet: { walletVkey: 'vkey_seller', walletAddress: 'addr' },
        NextAction: { requestedAction: 'WaitingForExternalAction' },
      },
    });
  });
  app.post('/payment/resolve-blockchain-identifier', (_req, res) =>
    res.json({ status: 'success', data: { blockchainIdentifier: 'bc_1', onChainState: state.onChainState, NextAction: { requestedAction: state.nextAction } } }),
  );
  app.post('/payment/submit-result', (_req, res) => {
    state.nextAction = 'SubmitResultRequested';
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

// ------------------------------------------------------------------ tests

describe('MIP-003 routes, unpaid mode', () => {
  it('availability and input_schema', async () => {
    const { req } = await boot();
    expect((await req('GET', '/availability')).body).toEqual({ status: 'available', type: 'masumi-agent', message: expect.any(String) });
    const schema = (await req('GET', '/input_schema')).body;
    expect(schema.input_data.map((f: any) => f.id)).toEqual(['task', 'skills', 'budget_usd', 'deadline_days', 'location', 'remote_ok', 'hours_needed', 'language', 'timezone', 'notes']);
  });

  it('start_job starts at once and returns a well-formed response', async () => {
    const { req, jobsById } = await boot();
    const r = await req('POST', '/start_job', { identifier_from_purchaser: 'my-id', input_data: { task: 'Logo', skills: 'figma' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ blockchainIdentifier: `free_${r.body.id}`, sellerVKey: '', identifierFromPurchaser: 'my-id', payment_required: false });
    expect(r.body.input_hash).toBe(inputHash({ task: 'Logo', skills: 'figma' }, 'my-id'));
    expect(jobsById.get(r.body.id)?.status).toBe('running');
    expect((await req('GET', `/status?job_id=${r.body.id}`)).body).toEqual({ status: 'running' });
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

  it('check-in flow over status and provide_input', async () => {
    const { req, jobsById, calls, store } = await boot();
    const { body } = await req('POST', '/start_job', { input_data: { task: 'Logo' } });
    const id = body.id as string;

    let r = await req('POST', '/provide_input', { job_id: id, input_data: { choice: 'fake:1' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not awaiting_input/);

    store.updateJob(id, { status: 'awaiting_input' });
    const st = (await req('GET', `/status?job_id=${id}`)).body;
    expect(st.status).toBe('awaiting_input');
    expect(st.input_schema.input_data[0].data.values).toHaveLength(4);
    expect(JSON.parse(st.result).candidates[0]).toMatchObject({ id: 'fake:1', score: 88, reason: 'good fit', unknowns: ['hours per week'], quote_usd: 100, url: 'https://x/fake:1' });

    r = await req('POST', '/provide_input', { job_id: id, input_data: { choice: 'fake:99' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/unknown candidate/);
    expect(calls.input).toHaveLength(0);

    r = await req('POST', '/provide_input', { job_id: id, input_schema_hash: 'x', input_data: { choice: st.input_schema.input_data[0].data.values[1] } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ input_hash: expect.stringMatching(/^[0-9a-f]{64}$/), signature: '' });
    expect(calls.input).toEqual([[id, { action: 'confirm', profileId: 'fake:2' }]]);

    store.updateJob(id, { status: 'awaiting_input' });
    r = await req('POST', '/provide_input', { job_id: id, input_data: { choice: 'fake:boom' } });
    expect(r.status).toBe(400); // unknown candidate, caught before the service
    expect(jobsById.get(id)?.status).toBe('awaiting_input');
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

describe('paid mode', () => {
  it('creates a payment, marks paid when funds lock, submits the result hash once', async () => {
    const ps = await fakePaymentService();
    const config = testConfig({ MASUMI_API_URL: ps.url, MASUMI_API_KEY: 'k', MASUMI_AGENT_IDENTIFIER: 'agent'.padEnd(60, 'a') });
    const { req, jobsById, calls, store, handle, deps } = await boot(config);

    const ifp = 'abcdef0123456789abcd';
    const r = await req('POST', '/start_job', { identifier_from_purchaser: ifp, input_data: { task: 'Logo' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ blockchainIdentifier: 'bc_1', sellerVKey: 'vkey_seller', identifierFromPurchaser: ifp, payment_required: true });
    expect(r.body.payByTime).toBeLessThan(r.body.submitResultTime);
    expect(r.body.submitResultTime).toBeLessThan(r.body.unlockTime);
    expect(r.body.unlockTime).toBeLessThan(r.body.externalDisputeUnlockTime);

    const created = ps.log.find((l) => l.path === '/payment')!;
    expect(created.token).toBe('k');
    expect(created.body).toMatchObject({ network: 'Preprod', agentIdentifier: config.MASUMI_AGENT_IDENTIFIER, identifierFromPurchaser: ifp, inputHash: r.body.input_hash });
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
    expect(submits[0]!.body).toEqual({ network: 'Preprod', blockchainIdentifier: 'bc_1', submitResultHash: resultHash(JSON.stringify(done.result), ifp) });
    expect(jobsById.get(r.body.id)?.payment?.resultSubmittedAt).toBeTypeOf('number');
    expect((await req('GET', `/status?job_id=${r.body.id}`)).body.result).toBe(JSON.stringify(done.result));
    handle.stop();
  });

  it('fails jobs that were not paid by payByTime', async () => {
    const ps = await fakePaymentService();
    const config = testConfig({ MASUMI_API_URL: ps.url, MASUMI_API_KEY: 'k', MASUMI_AGENT_IDENTIFIER: 'a'.repeat(60) });
    const { req, jobsById, deps } = await boot(config);
    const r = await req('POST', '/start_job', { identifier_from_purchaser: 'abcdef0123456789abcd', input_data: { task: 'Logo' } });
    const watcher = createWatcher(deps, createPaymentClient(config), { now: () => r.body.payByTime + 1 });
    await watcher.poll();
    expect(jobsById.get(r.body.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/payByTime/) });
  });

  it('answers 500 when the payment service is down', async () => {
    const config = testConfig({ MASUMI_API_URL: 'http://127.0.0.1:1', MASUMI_API_KEY: 'k', MASUMI_AGENT_IDENTIFIER: 'a'.repeat(60) });
    const { req, jobsById } = await boot(config);
    const r = await req('POST', '/start_job', { identifier_from_purchaser: 'abcdef0123456789abcd', input_data: { task: 'Logo' } });
    expect(r.status).toBe(500);
    expect(jobsById.size).toBe(0);
  });
});
