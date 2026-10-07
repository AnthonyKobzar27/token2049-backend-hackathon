// How identity plugs into the rest of HAAS: booking-engine QA events, the bounty board, and the router label.
import { describe, expect, it } from 'vitest';
import { createStore } from '../db/db';
import { createEventBus } from '../domain/events';
import type { Booking, Brief, FreelancerProfile, Job, VerificationReport } from '../domain/types';
import { bindBountyWallets, bountyWorkerOf } from '../bounty/identity';
import { rank } from '../router/match';
import { createMemoryChain } from './chain';
import { createCip68Issuer } from './issuer';
import { createReputationMinter } from './minter';
import { createIdentityRegistry } from './registry';
import { combineSignals } from './veridian/service';

const W1 = 'addr_test1_worker_one';

function setup(workerOf?: (b: Booking) => string | undefined) {
  const store = createStore(':memory:');
  const bus = createEventBus();
  const chain = createMemoryChain();
  const registry = createIdentityRegistry({ store, chain, issuer: createCip68Issuer(chain) });
  const minter = createReputationMinter({ store, bus, registry, ...(workerOf && { workerOf }) }, { verifyGraceMs: 600_000, intervalMs: 3_600_000 });
  return { store, bus, chain, registry, minter };
}
const job = (id: string): Job => ({ id, status: 'completed', client: 'local', brief: { task: 't', skills: [], remoteOk: true }, round: 1, createdAt: 1, updatedAt: 1 });
const booking = (id: string, patch: Partial<Booking> = {}): Booking => ({
  id, jobId: `job_${id}`, profileId: 'fake:w1', platform: 'fake', source: 'fake', status: 'completed', priceUsd: 50, paused: false, createdAt: 1, updatedAt: 1, ...patch,
});
const report = (verdict: VerificationReport['verdict'], resultHash = 'q'.repeat(64)): VerificationReport => ({
  verdict, score: verdict === 'pass' ? 0.9 : 0.1, checks: [], summary: verdict, resultHash, deliveryHash: 'd', attempt: 1, ms: 1, at: 1,
});

describe('reputation minter and the booking QA step', () => {
  it('a QA pass event (booking + report) queues the mint at once with the QA result hash', async () => {
    const { store, bus, registry, minter, chain } = setup();
    registry.bindWallet('fake:w1', W1);
    minter.start();
    const b = booking('bk1', { status: 'verified' });
    store.insertJob(job(b.jobId));
    store.insertBooking(b);
    bus.emit({ type: 'verification.completed', booking: b, report: report('pass') });
    const done = store.updateBooking('bk1', { status: 'completed' });
    bus.emit({ type: 'booking.updated', booking: done });
    expect(minter.task('bk1')?.status).toBe('queued');
    await minter.tick();
    minter.stop();
    expect(minter.task('bk1')?.status).toBe('done');
    expect(JSON.stringify(chain.txs[1]!.receiptMetadata)).toContain('q'.repeat(64));
  });

  it('a booking completed with a result hash (a person accepted a needs_human delivery) counts as verified', () => {
    const { store, bus, registry, minter } = setup();
    registry.bindWallet('fake:w1', W1);
    minter.start();
    store.insertJob(job('job_bk2'));
    const b = booking('bk2', { resultHash: 'h'.repeat(64) });
    store.insertBooking(b);
    bus.emit({ type: 'booking.updated', booking: b });
    minter.stop();
    expect(minter.task('bk2')?.status).toBe('queued');
  });

  it('a final QA rejection never mints', () => {
    const { store, bus, minter } = setup();
    minter.start();
    const b = booking('bk3', { status: 'rejected' });
    store.insertJob(job(b.jobId));
    store.insertBooking(b);
    bus.emit({ type: 'verification.rejected', booking: b, report: report('fail') });
    // Even if something later marks it completed, the recorded rejection wins.
    bus.emit({ type: 'booking.updated', booking: { ...b, status: 'completed' } });
    minter.stop();
    expect(minter.task('bk3')?.status).toBe('rejected');
  });

  it('credits the worker who actually did a broadcast bounty', () => {
    const { store, bus, minter } = setup((b) => (b.id === 'bk4' ? 'bounty:w_oliver' : undefined));
    minter.start();
    const b = booking('bk4', { platform: 'bounty', profileId: 'bounty:w_nithya' });
    store.insertJob(job(b.jobId));
    store.insertBooking(b);
    bus.emit({ type: 'booking.updated', booking: b });
    minter.stop();
    expect(minter.task('bk4')?.workerId).toBe('bounty:w_oliver');
  });
});

describe('bounty board identity helpers', () => {
  it('finds the worker who did a bounty booking, and binds verified workers\' Cardano wallets once', () => {
    const board = {
      list: () => [{ workerId: 'w_oliver', status: 'paid' }],
      listWorkers: () => [
        { id: 'w_a', verified: true, wallets: { cardano: 'addr_test1_a' } },
        { id: 'w_b', verified: false, wallets: { cardano: 'addr_test1_b' } },
        { id: 'w_c', verified: true, wallets: { solana: 'So1' } },
      ],
    } as never;
    expect(bountyWorkerOf(board, booking('x', { platform: 'bounty' }))).toBe('bounty:w_oliver');
    expect(bountyWorkerOf(board, booking('x'))).toBeUndefined();
    const bound = new Map<string, string>();
    const reg = { walletOf: (id: string) => bound.get(id), bindWallet: (id: string, a: string) => void bound.set(id, a) };
    expect(bindBountyWallets(board, reg)).toBe(1);
    expect([...bound]).toEqual([['bounty:w_a', 'addr_test1_a']]);
    expect(bindBountyWallets(board, reg)).toBe(0);
  });
});

describe('verified label in ranking', () => {
  const brief: Brief = { task: 'build a react dashboard', skills: ['react'], remoteOk: true };
  const prof = (id: string): FreelancerProfile => ({
    id, platform: 'fiverr', platformId: id, url: `https://x.test/${id}`, name: id, headline: 'h', skills: ['react'],
    pricing: [{ kind: 'fixed', amountUsd: 100, deliveryDays: 3 }], rating: 4.8, reviewCount: 100, fetchedAt: 0,
  });
  it('marks candidates confirmed by Cardano and/or Veridian, and only those', () => {
    const cardano = { signals: () => new Map([['a', { verified: true, cardano: true, jobsCompleted: 2 }]]) };
    const veridian = { signals: () => new Map([['a', { verified: true, veridian: true, jobsCompleted: 0 }], ['b', { verified: true, veridian: true, jobsCompleted: 0 }]]) };
    const onchain = combineSignals(cardano, veridian).signals(['a', 'b', 'c']);
    const suit = new Map(['a', 'b', 'c'].map((id) => [id, { score: 0.8, reason: 'fit' }]));
    const out = rank(brief, [prof('a'), prof('b'), prof('c')], suit, { limit: 5, onchain });
    const byId = Object.fromEntries(out.map((c) => [c.profile.id, c.identity]));
    expect(byId.a).toEqual({ verified: true, by: ['cardano', 'veridian'], jobsCompleted: 2 });
    expect(byId.b).toEqual({ verified: true, by: ['veridian'], jobsCompleted: 0 });
    expect(byId.c).toBeUndefined();
  });
});

describe('reputation minter ticks', () => {
  it('recovers after a failed tick and coalesces concurrent ticks', async () => {
    const { store, bus, registry, minter } = setup();
    registry.bindWallet('fake:w1', W1);
    store.insertJob(job('job_bk9'));
    const b = booking('bk9', { resultHash: 'h'.repeat(64) });
    store.insertBooking(b);
    minter.start();
    bus.emit({ type: 'booking.updated', booking: b });
    // The task index read fails once (e.g. SQLite busy).
    const getKv = store.getKv.bind(store);
    let fail = true;
    store.getKv = (k: string) => {
      if (fail && k === 'identity:tasks') {
        fail = false;
        throw new Error('database is locked');
      }
      return getKv(k);
    };
    await expect(minter.tick()).rejects.toThrow('database is locked');
    const ticks = [minter.tick(), minter.tick(), minter.tick()];
    expect(ticks[1]).toBe(ticks[2]); // one queued follow-up, not one per call
    await Promise.all(ticks);
    minter.stop();
    expect(minter.task('bk9')?.status).toBe('done');
  });
});
