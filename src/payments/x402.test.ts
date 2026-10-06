// The paywall needs a facilitator's /supported at first use (it builds the 402 from it), so these
// tests run local stub facilitators on loopback, one per chain. No Blockfrost, no RPC, no chain.

import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { testConfig, type Config } from '../config';
import { createStore } from '../db/db';
import type { ApiDeps, JobService, Store } from '../domain/ports';
import type { Job } from '../domain/types';
import { jobIdForTx, mountX402, pendingKey } from './x402';
import { MASUMI_USDM_PREPROD } from './x402-networks';

const PAY_TO = 'addr_test1qp7573my7h0fyj9cd2fwrws5v6ep0e6urpx007pz0pjnmakny46m3vmfawqwv3m48dv2s6eysht6tjfdk48lrzrkmj5qpmyq7l';
const SOL_PAY_TO = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const SOL_FEE_PAYER = 'CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5';
const SOL_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const listen = (app: express.Express) => new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const job = (patch: Partial<Job> = {}): Job => ({ id: 'job_x', status: 'awaiting_input', client: 'x402', brief: { task: 't', skills: [], remoteOk: true }, round: 1, createdAt: 1, updatedAt: 1, ...patch });

/** A job service over the real store, as in production (settlement is written to the same store). */
function fakeJobs(store: Store, initial: Job[] = []) {
  for (const j of initial) store.insertJob(j);
  const svc: JobService = {
    startJob: vi.fn(({ brief, client, id }) => { const j = job({ id: id ?? 'job_new', brief, client, status: 'running' }); store.insertJob(j); return j; }),
    markPaid: vi.fn(),
    getJob: (id) => store.getJob(id),
    getShortlist: () => null,
    provideInput: vi.fn((id) => store.getJob(id)!),
    tick: async () => {},
  };
  return svc;
}

/** Stub facilitator for one chain. `settleOk` can be flipped to simulate a failed settlement. */
function stubFacilitator(kind: Record<string, unknown>, settleTx: (payload: { transaction?: string }) => string) {
  const state = { settleOk: true, verifies: 0, settles: 0 };
  const f = express();
  f.use(express.json({ limit: '1mb' }));
  f.get('/supported', (_req, res) => res.json({ kinds: [{ x402Version: 2, scheme: 'exact', ...kind }], extensions: [], signers: {} }));
  f.post('/verify', (req, res) => {
    state.verifies++;
    res.json({ isValid: true, payer: 'payer_1', network: req.body.paymentRequirements.network });
  });
  f.post('/settle', (req, res) => {
    state.settles++;
    const network = req.body.paymentRequirements.network;
    if (!state.settleOk) return void res.json({ success: false, errorReason: 'settlement_pending', transaction: '', network });
    res.json({ success: true, transaction: settleTx(req.body.paymentPayload.payload), network, payer: 'payer_1' });
  });
  return { app: f, state };
}

const cardanoKind = { network: 'cardano:preprod', extra: { l1Confirmations: { minimum: 0, maximum: 20 }, assetTransferMethods: ['default'] } };
const solanaKind = { network: SOL_DEVNET, extra: { feePayer: SOL_FEE_PAYER } };

/** Mounts the paywall on a fresh app; returns its URL and a closer. */
async function mount(config: Config, deps: { jobs: JobService; store: Store }) {
  const app = express();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  mountX402(app, { ...deps, config, bus: {} as never } satisfies ApiDeps);
  log.mockRestore();
  const s = await listen(app);
  return { url: urlOf(s), close: () => s.close() };
}

const BRIEF = { task: 'logo design', skills: ['logo'] };
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function challenge(base: string) {
  const res = await post(`${base}/x402/route`, BRIEF);
  expect(res.status).toBe(402);
  return decodePaymentRequiredHeader(res.headers.get('payment-required')!);
}

/** A PAYMENT-SIGNATURE header for one of the offered requirements (the stub accepts any transaction). */
const paymentHeader = (accepted: PaymentRequirements, transaction: string, resource?: unknown) =>
  encodePaymentSignatureHeader({ x402Version: 2, accepted, payload: { transaction }, resource } as never);

describe('x402 paywall on both chains', () => {
  let cardano: ReturnType<typeof stubFacilitator>;
  let solana: ReturnType<typeof stubFacilitator>;
  let servers: Server[] = [];
  let config: Config;

  beforeAll(async () => {
    cardano = stubFacilitator(cardanoKind, () => 'c'.repeat(64));
    solana = stubFacilitator(solanaKind, () => '5'.repeat(88));
    servers = [await listen(cardano.app), await listen(solana.app)];
    config = testConfig({
      X402_PAY_TO: PAY_TO,
      X402_SOLANA_PAY_TO: SOL_PAY_TO,
      X402_FACILITATOR_URL: urlOf(servers[0]!),
      X402_FACILITATOR_FALLBACK_URL: 'off',
      X402_SOLANA_FACILITATOR_URL: urlOf(servers[1]!),
      PUBLIC_URL: 'http://haas.test',
    });
  });
  afterAll(() => servers.forEach((s) => s.close()));

  it('offers USDM on Cardano and USDC on Solana devnet in one 402', async () => {
    const store = createStore(':memory:');
    const api = await mount(config, { jobs: fakeJobs(store), store });
    const required = await challenge(api.url);
    expect(required.x402Version).toBe(2);
    expect(required.accepts).toHaveLength(2);
    expect(required.accepts[0]).toMatchObject({ scheme: 'exact', network: 'cardano:preprod', amount: '500000', asset: MASUMI_USDM_PREPROD, payTo: PAY_TO });
    expect((required.accepts[0]!.extra as { confirmationPolicy: { l1Confirmations: number } }).confirmationPolicy.l1Confirmations).toBe(0);
    expect(required.accepts[1]).toMatchObject({ scheme: 'exact', network: SOL_DEVNET, amount: '500000', asset: USDC_DEVNET, payTo: SOL_PAY_TO });
    expect(required.accepts[1]!.extra).toMatchObject({ feePayer: SOL_FEE_PAYER, tokenProgram: expect.any(String) });
    api.close();
  });

  it('rejects a bad brief before asking for payment', async () => {
    const store = createStore(':memory:');
    const api = await mount(config, { jobs: fakeJobs(store), store });
    expect((await post(`${api.url}/x402/route`, { skills: ['x'] })).status).toBe(400);
    api.close();
  });

  it('pays on Solana: starts one job after settlement, records the tx and explorer link, idempotent on retry', async () => {
    const store = createStore(':memory:');
    const jobs = fakeJobs(store);
    const api = await mount(config, { jobs, store });
    const required = await challenge(api.url);
    const sol = required.accepts.find((a) => a.network === SOL_DEVNET)!;
    const tx = Buffer.from('signed-solana-tx').toString('base64');
    const header = paymentHeader(sol, tx, required.resource);

    const res = await post(`${api.url}/x402/route`, BRIEF, { 'payment-signature': header });
    expect(res.status).toBe(202);
    const id = jobIdForTx(sha256(tx));
    expect(await res.json()).toEqual({ job_id: id, status_url: `http://haas.test/x402/jobs/${id}` });
    const receipt = decodePaymentResponseHeader(res.headers.get('payment-response')!);
    expect(receipt).toMatchObject({ success: true, transaction: '5'.repeat(88), network: SOL_DEVNET });

    expect(jobs.startJob).toHaveBeenCalledTimes(1);
    expect(jobs.startJob).toHaveBeenCalledWith({ brief: expect.objectContaining({ task: 'logo design' }), client: 'x402', id });
    expect(store.getJob(id)?.settlement).toMatchObject({
      protocol: 'x402',
      network: SOL_DEVNET,
      asset: 'USDC',
      amount: '500000',
      transaction: '5'.repeat(88),
      explorerUrl: `https://explorer.solana.com/tx/${'5'.repeat(88)}?cluster=devnet`,
      payer: 'payer_1',
    });
    expect(store.getKv(pendingKey(id))).toBe('');

    const status = await (await fetch(`${api.url}/x402/jobs/${id}`)).json();
    expect(status).toMatchObject({ job_id: id, status: 'running', settlement: { explorerUrl: expect.stringContaining('cluster=devnet') } });

    // The same payment again: same job, no second start.
    const again = await post(`${api.url}/x402/route`, BRIEF, { 'payment-signature': header });
    expect((await again.json()).job_id).toBe(id);
    expect(jobs.startJob).toHaveBeenCalledTimes(1);
    api.close();
  });

  it('pays on Cardano: cardanoscan preprod link on the job', async () => {
    const store = createStore(':memory:');
    const jobs = fakeJobs(store);
    const api = await mount(config, { jobs, store });
    const required = await challenge(api.url);
    const ada = required.accepts.find((a) => a.network === 'cardano:preprod')!;
    const tx = 'not-real-cbor';
    const res = await post(`${api.url}/x402/route`, BRIEF, { 'payment-signature': paymentHeader(ada, tx, required.resource) });
    expect(res.status).toBe(202);
    const id = jobIdForTx(sha256(tx));
    expect(store.getJob(id)?.settlement).toMatchObject({ network: 'cardano:preprod', asset: 'USDM', transaction: 'c'.repeat(64), explorerUrl: `https://preprod.cardanoscan.io/transaction/${'c'.repeat(64)}` });
    api.close();
  });

  it('keeps the brief in the store across a restart and starts the job once settlement succeeds', async () => {
    const store = createStore(':memory:');
    const jobs = fakeJobs(store);
    const first = await mount(config, { jobs, store });
    const required = await challenge(first.url);
    const sol = required.accepts.find((a) => a.network === SOL_DEVNET)!;
    const tx = Buffer.from('restart-tx').toString('base64');
    const header = paymentHeader(sol, tx, required.resource);
    const id = jobIdForTx(sha256(tx));

    solana.state.settleOk = false;
    const failed = await post(`${first.url}/x402/route`, { ...BRIEF, task: 'persisted brief' }, { 'payment-signature': header });
    expect(failed.status).toBe(402);
    expect(jobs.startJob).not.toHaveBeenCalled();
    expect(JSON.parse(store.getKv(pendingKey(id))!)).toMatchObject({ brief: { task: 'persisted brief' }, network: SOL_DEVNET });
    expect(await (await fetch(`${first.url}/x402/jobs/${id}`)).json()).toMatchObject({ job_id: id, status: 'awaiting_payment' });
    first.close();

    // "Restart": a new server over the same store. The settle hook finds the stored brief.
    solana.state.settleOk = true;
    const second = await mount(config, { jobs, store });
    const ok = await post(`${second.url}/x402/route`, { ...BRIEF, task: 'a different brief' }, { 'payment-signature': header });
    expect(ok.status).toBe(202);
    expect(jobs.startJob).toHaveBeenCalledTimes(1);
    expect(store.getJob(id)?.brief.task).toBe('persisted brief');
    second.close();
  });

  it('serves job status, only for x402 jobs, and maps input', async () => {
    const store = createStore(':memory:');
    const jobs = fakeJobs(store, [job({ id: 'job_wait' }), job({ id: 'job_done', status: 'completed' }), job({ id: 'job_other', client: 'masumi' })]);
    const api = await mount(config, { jobs, store });
    const ok = await fetch(`${api.url}/x402/jobs/job_wait`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ job_id: 'job_wait', status: 'awaiting_input', candidates: [] });
    expect((await fetch(`${api.url}/x402/jobs/job_other`)).status).toBe(404);
    expect((await fetch(`${api.url}/x402/jobs/nope`)).status).toBe(404);
    expect((await post(`${api.url}/x402/jobs/job_wait/input`, { action: 'cancel' })).status).toBe(200);
    expect(jobs.provideInput).toHaveBeenCalledWith('job_wait', { action: 'cancel' });
    expect((await post(`${api.url}/x402/jobs/job_done/input`, { action: 'cancel' })).status).toBe(409);
    expect((await post(`${api.url}/x402/jobs/job_wait/input`, { action: 'confirm' })).status).toBe(400);
    api.close();
  });

  it('switches chain with one setting: X402_NETWORK=solana:devnet offers only Solana USDC', async () => {
    const store = createStore(':memory:');
    const api = await mount({ ...config, X402_NETWORK: 'solana:devnet' }, { jobs: fakeJobs(store), store });
    const required = await challenge(api.url);
    expect(required.accepts.map((a) => a.network)).toEqual([SOL_DEVNET]);
    api.close();
  });

  it('prices Cardano in tADA with X402_ASSET=ADA', async () => {
    const store = createStore(':memory:');
    const api = await mount({ ...config, X402_ASSET: 'ADA' }, { jobs: fakeJobs(store), store });
    const required = await challenge(api.url);
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({ network: 'cardano:preprod', amount: '2000000', asset: 'lovelace' });
    api.close();
  });

  it('falls back to the self-hosted Cardano facilitator when the hosted one is down', async () => {
    const dead = await listen(express());
    const deadUrl = urlOf(dead);
    dead.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStore(':memory:');
    const api = await mount({ ...config, X402_NETWORK: 'cardano:preprod', X402_FACILITATOR_URL: deadUrl, X402_FACILITATOR_FALLBACK_URL: urlOf(servers[0]!) }, { jobs: fakeJobs(store), store });
    const required = await challenge(api.url);
    expect(required.accepts[0]).toMatchObject({ network: 'cardano:preprod', asset: MASUMI_USDM_PREPROD });
    warn.mockRestore();
    api.close();
  });

  it('derives a stable job id from the payment', () => {
    expect(jobIdForTx('ABCDEF0123456789abcdef')).toBe('job_abcdef012345');
  });
});

describe('x402 disabled', () => {
  it('mounts no paywall without any pay-to address but keeps job routes', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createStore(':memory:');
    const app = express();
    mountX402(app, { jobs: fakeJobs(store, [job()]), store, config: testConfig(), bus: {} as never });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('x402 disabled'));
    log.mockRestore();
    const s = await listen(app);
    const api = { url: urlOf(s), close: () => s.close() };
    expect((await fetch(`${api.url}/x402/route`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${api.url}/x402/jobs/job_x`)).status).toBe(200);
    api.close();
  });
});
