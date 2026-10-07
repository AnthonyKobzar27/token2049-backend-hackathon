// Registry, minter and HTTP API against the in-memory chain: no network, deterministic clock.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { createStore } from '../db/db';
import { createEventBus } from '../domain/events';
import type { Store } from '../domain/ports';
import type { Booking, Job } from '../domain/types';
import { mountIdentity } from './api';
import { createMemoryChain, type MemoryChain } from './chain';
import { applyJob, chunk64, credentialAssetName, credentialDatumFields, decodeCip68Datum, encodeCip68Datum, receiptAssetName, reputationFromFields } from './cip68';
import { createIdentity, type Identity } from './index';
import { createCip68Issuer, createVeridianIssuer } from './issuer';
import { createReputationMinter } from './minter';
import { createIdentityRegistry } from './registry';
import { emptyReputation } from './types';

const W1 = 'addr_test1_worker_one';
const W2 = 'addr_test1_worker_two';
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: { chain?: MemoryChain; minter?: Parameters<typeof createReputationMinter>[1] } = {}) {
  let t = 1_000_000;
  const now = () => t;
  const advance = (ms: number) => void (t += ms);
  const store = createStore(':memory:');
  const bus = createEventBus();
  const chain = opts.chain ?? createMemoryChain();
  const issuer = createCip68Issuer(chain, { now });
  const registry = createIdentityRegistry({ store, chain, issuer, now, ttlMs: 60_000 });
  const minter = createReputationMinter({ store, bus, registry }, { verifyGraceMs: 600_000, baseBackoffMs: 1_000, maxAttempts: 3, intervalMs: 3_600_000, now, ...opts.minter });
  return { store, bus, chain, issuer, registry, minter, now, advance };
}

const job = (id: string, patch: Partial<Job> = {}): Job => ({ id, status: 'completed', client: 'local', brief: { task: 't', skills: [], remoteOk: true }, round: 1, createdAt: 1, updatedAt: 1, ...patch });
const booking = (id: string, patch: Partial<Booking> = {}): Booking => ({
  id, jobId: `job_${id}`, profileId: 'fake:w1', platform: 'fake', source: 'fake', status: 'completed', priceUsd: 120, paused: false, createdAt: 1, updatedAt: 1, ...patch,
});
function complete(store: Store, bus: ReturnType<typeof createEventBus>, b: Booking) {
  if (!store.getJob(b.jobId)) store.insertJob(job(b.jobId));
  store.insertBooking(b);
  bus.emit({ type: 'booking.updated', booking: b });
}

// ------------------------------------------------------------------ cip68

describe('cip68 helpers', () => {
  it('round-trips the reputation datum and keeps asset names within 32 bytes', () => {
    const rep = applyJob(emptyReputation(), { jobId: 'j', bookingId: 'b', resultHash: 'h', qaPassed: true, paymentTx: 'p', priceUsd: 99.99, rating: 4.5, at: 5 });
    const fields = credentialDatumFields({ workerId: 'fake:w1', walletAddress: W1, issuedAt: 1, reputation: rep });
    const back = reputationFromFields(decodeCip68Datum(encodeCip68Datum(fields))!);
    expect(back).toMatchObject({ jobsCompleted: 1, verifiedJobs: 1, ratedJobs: 1, ratingSum: 4.5, totalEarnedUsd: 99.99, lastJobId: 'j', lastPaymentTx: 'p' });
    expect(Buffer.from(credentialAssetName('x'.repeat(500)), 'hex').length + 4).toBeLessThanOrEqual(32);
    expect(Buffer.from(receiptAssetName('bk'), 'hex').length).toBeLessThanOrEqual(32);
    expect(credentialAssetName('a')).toBe(credentialAssetName('a'));
  });
  it('chunks metadata strings at 64 bytes', () => {
    expect(chunk64('short')).toBe('short');
    const parts = chunk64('x'.repeat(130)) as string[];
    expect(parts.map((p) => p.length)).toEqual([64, 64, 2]);
  });
});

// --------------------------------------------------------------- registry

describe('IdentityRegistry', () => {
  it('issues one credential per worker, idempotently, and looks it up by wallet', async () => {
    const { registry, chain } = setup();
    const [a, b] = await Promise.all([registry.issueCredential('fake:w1', W1), registry.issueCredential('fake:w1', W1)]);
    expect(a).toEqual(b);
    expect(chain.txs.filter((t) => t.kind === 'mint')).toHaveLength(1);
    expect(await registry.issueCredential('fake:w1')).toEqual(a);
    expect(chain.txs).toHaveLength(1);
    expect(registry.workerByWallet(W1)).toBe('fake:w1');
    expect(registry.walletOf('fake:w1')).toBe(W1);
    expect(a.refUnit).toBe(`${a.policyId}000643b0${a.assetName}`);
    expect(a.userUnit).toBe(`${a.policyId}000de140${a.assetName}`);
    expect(await chain.holderOf(a.userUnit)).toBe(W1);
    expect(await chain.holderOf(a.refUnit)).toBe(await chain.operatorAddress());
    expect(registry.knownWorkers()).toEqual(['fake:w1']);
  });

  it('refuses to rebind a wallet or a credentialed worker', async () => {
    const { registry } = setup();
    registry.bindWallet('fake:w1', W1);
    expect(() => registry.bindWallet('fake:w2', W1)).toThrow(/already bound/);
    await registry.issueCredential('fake:w1');
    expect(() => registry.bindWallet('fake:w1', W2)).toThrow(/already holds/);
    await expect(registry.issueCredential('fake:nobody')).rejects.toThrow(/no wallet/);
  });

  it('serves ranking signals from cache only and counts as verified once the chain confirms', async () => {
    const { registry, chain, advance } = setup();
    await registry.issueCredential('fake:w1', W1);
    const first = registry.signals(['fake:w1', 'fake:unknown']);
    expect(first.get('fake:w1')).toEqual({ verified: false, jobsCompleted: 0 });
    expect(first.has('fake:unknown')).toBe(false);
    await flush();
    expect(registry.signals(['fake:w1']).get('fake:w1')).toEqual({ verified: true, cardano: true, jobsCompleted: 0 });

    // Moving the user NFT away breaks the binding: no boost.
    chain.transfer(registry.credentialOf('fake:w1')!.userUnit, W2);
    advance(61_000);
    registry.signals(['fake:w1']);
    await flush();
    expect(registry.signals(['fake:w1']).get('fake:w1')?.verified).toBe(false);
    expect(registry.lastCheck('fake:w1')?.status.holder).toBe(W2);
  });

  it('bounds a slow chain read by the timeout and fills the cache when it lands', async () => {
    const chain = createMemoryChain();
    const { registry } = setup({ chain });
    await registry.issueCredential('fake:w1', W1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = chain.readReference.bind(chain);
    chain.readReference = async (n) => {
      await gate;
      return orig(n);
    };
    expect(await registry.refresh('fake:w1', 10)).toBeNull();
    expect(registry.lastCheck('fake:w1')).toBeUndefined();
    release();
    await flush();
    await flush();
    expect(registry.lastCheck('fake:w1')?.status).toMatchObject({ valid: true, bound: true });
  });

  it('keeps the last good answer when a refresh fails', async () => {
    const { registry, chain } = setup();
    await registry.issueCredential('fake:w1', W1);
    await registry.refresh('fake:w1');
    const orig = chain.readReference.bind(chain);
    chain.readReference = async () => Promise.reject(new Error('blockfrost 500'));
    await registry.refresh('fake:w1');
    expect(registry.lastCheck('fake:w1')?.status.valid).toBe(true);
    chain.readReference = orig;
  });
});

// ----------------------------------------------------------------- minter

describe('ReputationMinter', () => {
  it('records a completed, verified job on chain: datum update plus a receipt NFT with links', async () => {
    const { store, bus, chain, registry, minter } = setup();
    registry.bindWallet('fake:w1', W1);
    minter.start();
    complete(store, bus, booking('bk1'));
    expect(minter.task('bk1')?.status).toBe('waiting_verification');
    bus.emit({ type: 'payment.collected', jobId: 'job_bk1', txHash: 'c'.repeat(64) } as never);
    bus.emit({ type: 'verification.completed', bookingId: 'bk1', passed: true, resultHash: 'r'.repeat(64), rating: 5 } as never);
    await minter.tick();
    minter.stop();

    const task = minter.task('bk1')!;
    expect(task.status).toBe('done');
    expect(chain.txs.map((t) => t.kind)).toEqual(['mint', 'update']);
    const cred = registry.credentialOf('fake:w1')!;
    const ref = await chain.readReference(cred.assetName);
    expect(reputationFromFields(ref!.fields)).toMatchObject({ jobsCompleted: 1, verifiedJobs: 1, ratedJobs: 1, ratingSum: 5, totalEarnedUsd: 120, lastBookingId: 'bk1', lastPaymentTx: 'c'.repeat(64), lastResultHash: 'r'.repeat(64) });
    expect(ref!.fields.prevTx).toBe(cred.txHash);

    const update = chain.txs[1]!;
    expect(update.mints).toEqual([`${cred.policyId}${receiptAssetName('bk1')}`]);
    const meta = JSON.stringify(update.receiptMetadata);
    expect(meta).toContain('job_bk1');
    expect(meta).toContain('r'.repeat(64));
    expect(meta).toContain('"paymentKind":"masumi-collection"');
    expect(await chain.holderOf(task.receiptUnit!)).toBe(W1);

    expect(registry.reputationOf('fake:w1').jobsCompleted).toBe(1);
    expect(registry.receiptsOf('fake:w1')).toHaveLength(1);
  });

  it('is idempotent per booking, including after a crash between submit and bookkeeping', async () => {
    const { store, bus, chain, registry, minter } = setup();
    registry.bindWallet('fake:w1', W1);
    minter.start();
    const b = booking('bk1');
    complete(store, bus, b);
    bus.emit({ type: 'booking.updated', booking: b });
    minter.recordVerification({ bookingId: 'bk1', passed: true, resultHash: 'h' });
    await minter.tick();
    await minter.tick();
    expect(chain.txs.filter((t) => t.kind === 'update')).toHaveLength(1);

    // Simulate a restart that lost the "done" write: the chain already holds this booking.
    store.setKv('identity:task:bk1', JSON.stringify({ ...minter.task('bk1'), status: 'queued', nextAt: 0 }));
    store.setKv('identity:tasks', JSON.stringify(['bk1']));
    await minter.tick();
    minter.stop();
    expect(chain.txs.filter((t) => t.kind === 'update')).toHaveLength(1);
    expect(minter.task('bk1')?.status).toBe('done');
  });

  it('retries with backoff and gives up after maxAttempts', async () => {
    const { store, bus, chain, registry, minter, advance } = setup();
    await registry.issueCredential('fake:w1', W1);
    minter.start();
    complete(store, bus, booking('bk1'));
    minter.recordVerification({ bookingId: 'bk1', passed: true, resultHash: 'h' });
    chain.failNext(1, 'blockfrost 429');
    await minter.tick();
    expect(minter.task('bk1')).toMatchObject({ status: 'queued', attempts: 1, error: 'blockfrost 429' });
    await minter.tick(); // backoff not elapsed
    expect(minter.task('bk1')?.attempts).toBe(1);
    advance(1_000);
    await minter.tick();
    expect(minter.task('bk1')?.status).toBe('done');

    complete(store, bus, booking('bk2'));
    minter.recordVerification({ bookingId: 'bk2', passed: true, resultHash: 'h2' });
    chain.failNext(99);
    for (let i = 0; i < 5; i++) {
      await minter.tick();
      advance(60_000);
    }
    minter.stop();
    expect(minter.task('bk2')).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('never blocks the booking flow, even when the chain hangs', async () => {
    const chain = createMemoryChain();
    chain.updateReference = () => new Promise(() => {});
    chain.mintCredential = () => new Promise(() => {});
    const { store, bus, registry, minter } = setup({ chain });
    registry.bindWallet('fake:w1', W1);
    minter.start();
    minter.recordVerification({ bookingId: 'bk1', passed: true, resultHash: 'h' });
    const t0 = performance.now();
    complete(store, bus, booking('bk1'));
    expect(performance.now() - t0).toBeLessThan(50);
    minter.stop();
  });

  it('records nothing for a job that failed QA', async () => {
    const { store, bus, chain, registry, minter } = setup();
    registry.bindWallet('fake:w1', W1);
    minter.start();
    complete(store, bus, booking('bk1'));
    minter.recordVerification({ bookingId: 'bk1', passed: false, resultHash: 'h' });
    await minter.tick();
    minter.stop();
    expect(minter.task('bk1')?.status).toBe('rejected');
    expect(chain.txs).toHaveLength(0);
  });

  it('mints after the grace period without a QA verdict, unless verification is required', async () => {
    const a = setup();
    a.registry.bindWallet('fake:w1', W1);
    a.minter.start();
    complete(a.store, a.bus, booking('bk1'));
    await a.minter.tick();
    expect(a.minter.task('bk1')?.status).toBe('waiting_verification');
    a.advance(600_001);
    await a.minter.tick();
    a.minter.stop();
    expect(a.minter.task('bk1')?.status).toBe('done');
    expect(a.registry.receiptsOf('fake:w1')[0]).toMatchObject({ resultHashKind: 'booking', qaPassed: null });

    const b = setup({ minter: { requireVerification: true } });
    b.registry.bindWallet('fake:w1', W1);
    b.minter.start();
    complete(b.store, b.bus, booking('bk1'));
    b.advance(10 * 600_000);
    await b.minter.tick();
    b.minter.stop();
    expect(b.minter.task('bk1')?.status).toBe('waiting_verification');
    expect(b.chain.txs).toHaveLength(0);
  });

  it('waits for a wallet, then issues the credential and records the job', async () => {
    const { store, bus, chain, registry, minter } = setup();
    minter.start();
    complete(store, bus, booking('bk1'));
    minter.recordVerification({ bookingId: 'bk1', passed: true, resultHash: 'h' });
    await minter.tick();
    expect(minter.task('bk1')?.status).toBe('waiting_wallet');
    registry.bindWallet('fake:w1', W1);
    await minter.tick();
    minter.stop();
    expect(minter.task('bk1')?.status).toBe('done');
    expect(chain.txs.map((t) => t.kind)).toEqual(['mint', 'update']);
  });

  it('accumulates totals over several jobs and links each update to the previous one', async () => {
    const { store, bus, chain, registry, minter } = setup();
    registry.bindWallet('fake:w1', W1);
    minter.start();
    for (const [i, rating] of [[1, 4], [2, 5], [3, undefined]] as const) {
      complete(store, bus, booking(`bk${i}`, { priceUsd: 100 }));
      minter.recordVerification({ bookingId: `bk${i}`, passed: true, resultHash: `h${i}`, ...(rating ? { rating } : {}) });
      await minter.tick();
    }
    minter.stop();
    const sig = (await registry.refresh('fake:w1'))!.status.reputation!;
    expect(sig).toMatchObject({ jobsCompleted: 3, verifiedJobs: 3, ratedJobs: 2, ratingSum: 9, totalEarnedUsd: 300 });
    const updates = chain.txs.filter((t) => t.kind === 'update');
    expect(sig.lastUpdateTx).toBe(updates[2]!.txHash);
    expect(registry.signals(['fake:w1']).get('fake:w1')).toEqual({ verified: true, cardano: true, jobsCompleted: 3, avgRating: 4.5 });
  });
});

// ---------------------------------------------------------------- issuers

describe('CredentialIssuer', () => {
  it('reports an unbound credential when the reference datum names another wallet', async () => {
    const chain = createMemoryChain();
    const issuer = createCip68Issuer(chain);
    const cred = await issuer.issue({ workerId: 'fake:w1', walletAddress: W1 });
    expect(await issuer.status(cred)).toMatchObject({ valid: true, bound: true, holder: W1 });
    expect(await issuer.status({ ...cred, walletAddress: W2 })).toMatchObject({ valid: false, bound: false });
  });
  it('has a Veridian placeholder that fails loudly', async () => {
    const v = createVeridianIssuer();
    expect(v.kind).toBe('veridian');
    await expect(v.issue({ workerId: 'x', walletAddress: 'y' })).rejects.toThrow(/Veridian/);
  });
});

// -------------------------------------------------------------------- api

describe('identity HTTP API', () => {
  let server: Server | undefined;
  afterEach(() => void server?.close());
  const serve = async (identity: Identity | null) => {
    const app = express();
    mountIdentity(app, identity);
    server = await new Promise<Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  it('returns 503 when identity is not configured', async () => {
    expect(createIdentity({ store: createStore(':memory:'), bus: createEventBus(), config: testConfig() })).toBeNull();
    const url = await serve(null);
    expect((await fetch(`${url}/workers/fake:w1/reputation`)).status).toBe(503);
  });

  it('serves asset ids, metadata and Cardanoscan preprod links', async () => {
    const store = createStore(':memory:');
    const bus = createEventBus();
    const identity = createIdentity({ store, bus, config: testConfig(), chain: createMemoryChain() })!;
    identity.registry.bindWallet('fake:w1', W1);
    identity.minter.start();
    complete(store, bus, booking('bk1'));
    identity.minter.recordVerification({ bookingId: 'bk1', passed: true, resultHash: 'h'.repeat(64), rating: 4 });
    await identity.minter.tick();
    identity.minter.stop();

    const url = await serve(identity);
    const res = await fetch(`${url}/workers/${encodeURIComponent('fake:w1')}/reputation`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.network).toBe('preprod');
    expect(body.credential.referenceAsset).toMatch(/000643b0/);
    expect(body.credential.userAsset).toMatch(/000de140/);
    expect(body.credential.links.userToken).toMatch(/^https:\/\/preprod\.cardanoscan\.io\/token\//);
    expect(body.onChain).toMatchObject({ verified: true, holder: W1 });
    expect(body.reputation).toMatchObject({ jobsCompleted: 1, avgRating: 4, totalEarnedUsd: 120 });
    expect(body.reputation.links.lastUpdateTx).toMatch(/^https:\/\/preprod\.cardanoscan\.io\/transaction\//);
    expect(body.receipts[0].links.token).toMatch(/cardanoscan/);
    expect(body.receipts[0].jobId).toBe('job_bk1');

    const byWallet = await fetch(`${url}/workers/by-wallet/${W1}/reputation?refresh=0`);
    expect(((await byWallet.json()) as { workerId: string }).workerId).toBe('fake:w1');
    expect((await fetch(`${url}/workers/fake:nobody/reputation`)).status).toBe(404);
    const info = (await (await fetch(`${url}/identity`)).json()) as Record<string, any>;
    expect(info).toMatchObject({ network: 'preprod', chain: 'memory', issuer: 'cip68', workers: 1 });
  });
});
