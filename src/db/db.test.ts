import { describe, expect, it, vi, afterEach } from 'vitest';
import { createStore } from './db';
import type { Approval, Booking, ConversationMessage, EscrowRecord, FreelancerProfile, Job, Shortlist } from '../domain/types';

const job = (o: Partial<Job> = {}): Job => ({ id: 'j1', status: 'running', client: 'local', brief: { task: 't', skills: ['a'], remoteOk: true }, round: 1, createdAt: 1, updatedAt: 1, ...o });
const profile = (id: string): FreelancerProfile => ({ id: `fake:${id}`, platform: 'fake', platformId: id, url: 'u', name: id, headline: 'h', skills: [], pricing: [], fetchedAt: 1 });
const booking = (o: Partial<Booking> = {}): Booking => ({ id: 'b1', jobId: 'j1', profileId: 'fake:1', platform: 'fake', source: 'fake', status: 'pending_escrow', priceUsd: 10, paused: false, createdAt: 1, updatedAt: 1, ...o });
const escrow = (o: Partial<EscrowRecord> = {}): EscrowRecord => ({ id: 'e1', bookingId: 'b1', provider: 'memory', status: 'awaiting_deposit', amount: 10, currency: 'USDC', createdAt: 1, updatedAt: 1, ...o });
const msg = (o: Partial<ConversationMessage> = {}): ConversationMessage => ({ id: 'm1', jobId: 'j1', bookingId: 'b1', thread: 'freelancer', from: 'freelancer', text: 'hi', externalId: 'x1', createdAt: 1, ...o });

afterEach(() => vi.useRealTimers());

describe('store', () => {
  it('round-trips jobs, merges patches and filters', () => {
    const s = createStore(':memory:');
    s.insertJob(job({ clientRef: 'chat1' }));
    s.insertJob(job({ id: 'j2', status: 'completed', client: 'telegram' }));
    expect(s.getJob('j1')).toMatchObject({ id: 'j1', clientRef: 'chat1' });
    expect(s.getJob('nope')).toBeNull();
    const up = s.updateJob('j1', { status: 'awaiting_input', shortlistId: 'sl' });
    expect(up.status).toBe('awaiting_input');
    expect(up.updatedAt).toBeGreaterThan(1);
    expect(up.brief.task).toBe('t');
    expect(s.listJobs({ status: 'awaiting_input' }).map((j) => j.id)).toEqual(['j1']);
    expect(s.listJobs({ client: 'telegram' }).map((j) => j.id)).toEqual(['j2']);
    expect(s.listJobs({ clientRef: 'chat1' })).toHaveLength(1);
    expect(s.listJobs()).toHaveLength(2);
    expect(() => s.updateJob('missing', {})).toThrow();
  });

  it('round-trips shortlists and finds the latest', () => {
    const s = createStore(':memory:');
    const sl = (id: string, round: number): Shortlist => ({ id, jobId: 'j1', round, candidates: [], sources: [], createdAt: round });
    s.insertShortlist(sl('s1', 1));
    s.insertShortlist(sl('s2', 2));
    expect(s.getShortlist('s1')?.round).toBe(1);
    expect(s.latestShortlist('j1')?.id).toBe('s2');
    expect(s.latestShortlist('other')).toBeNull();
  });

  it('caches profiles with expiry and upserts each profile', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const s = createStore(':memory:');
    expect(s.getCachedProfiles('fake', 'q', 1000)).toBeNull();
    s.putProfiles('fake', 'q', [profile('1'), profile('2')]);
    expect(s.getCachedProfiles('fake', 'q', 1000)?.map((p) => p.id)).toEqual(['fake:1', 'fake:2']);
    expect(s.getProfile('fake:2')?.name).toBe('2');
    expect(s.getProfile('fake:9')).toBeNull();
    vi.setSystemTime(1_000_500);
    expect(s.getCachedProfiles('fake', 'q', 1000)).not.toBeNull();
    vi.setSystemTime(1_002_000);
    expect(s.getCachedProfiles('fake', 'q', 1000)).toBeNull();
    expect(s.getCachedProfiles('fake', 'other', 10_000_000)).toBeNull();
    s.putProfiles('fake', 'q', [{ ...profile('1'), name: 'renamed' }]);
    expect(s.getProfile('fake:1')?.name).toBe('renamed');
    expect(s.getCachedProfiles('fake', 'q', 1000)).toHaveLength(1);
  });

  it('stores suitability scores', () => {
    const s = createStore(':memory:');
    expect(s.getSuitability('b', 'p')).toBeNull();
    s.putSuitability('b', 'p', { score: 0.5, reason: 'ok' });
    s.putSuitability('b', 'p', { score: 0.7, reason: 'better' });
    expect(s.getSuitability('b', 'p')).toEqual({ score: 0.7, reason: 'better' });
  });

  it('round-trips bookings', () => {
    const s = createStore(':memory:');
    s.insertBooking(booking());
    s.insertBooking(booking({ id: 'b2', jobId: 'j2', status: 'placed' }));
    expect(s.updateBooking('b1', { status: 'escrowed', escrowId: 'e1' })).toMatchObject({ status: 'escrowed', escrowId: 'e1', priceUsd: 10 });
    expect(s.getBooking('b1')?.status).toBe('escrowed');
    expect(s.listBookings({ status: ['placed'] }).map((b) => b.id)).toEqual(['b2']);
    expect(s.listBookings({ status: ['placed', 'escrowed'] })).toHaveLength(2);
    expect(s.listBookings({ status: [] })).toEqual([]);
    expect(s.listBookings({ jobId: 'j1' })).toHaveLength(1);
  });

  it('dedupes messages on (bookingId, externalId)', () => {
    const s = createStore(':memory:');
    expect(s.addMessage(msg())).toBe(true);
    expect(s.addMessage(msg({ id: 'm2' }))).toBe(false);
    expect(s.addMessage(msg({ id: 'm3', bookingId: 'b2' }))).toBe(true);
    expect(s.addMessage(msg({ id: 'm4', externalId: undefined }))).toBe(true);
    expect(s.addMessage(msg({ id: 'm5', externalId: undefined }))).toBe(true);
    expect(s.listMessages({ bookingId: 'b1' })).toHaveLength(3);
    expect(s.listMessages({ jobId: 'j1', thread: 'hirer' })).toHaveLength(0);
  });

  it('round-trips approvals', () => {
    const s = createStore(':memory:');
    const a: Approval = { id: 'a1', action: 'book', summary: 's', status: 'pending', createdAt: 1 };
    s.insertApproval(a);
    s.insertApproval({ ...a, id: 'a2', status: 'approved' });
    expect(s.updateApproval('a1', { status: 'denied', decidedBy: 'op' })).toMatchObject({ status: 'denied', decidedBy: 'op', summary: 's' });
    expect(s.getApproval('a2')?.status).toBe('approved');
    expect(s.listApprovals({ status: 'denied' }).map((x) => x.id)).toEqual(['a1']);
    expect(s.listApprovals()).toHaveLength(2);
  });

  it('round-trips escrows', () => {
    const s = createStore(':memory:');
    s.insertEscrow(escrow());
    expect(s.updateEscrow('e1', { status: 'funded' }).status).toBe('funded');
    expect(s.getEscrowByBooking('b1')?.id).toBe('e1');
    expect(s.getEscrow('e1')?.amount).toBe(10);
    expect(s.listEscrows({ status: ['funded'] })).toHaveLength(1);
    expect(s.listEscrows({ status: ['released'] })).toHaveLength(0);
    expect(s.getEscrowByBooking('nope')).toBeNull();
  });

  it('has a key-value store and an idempotent schema', () => {
    const s = createStore(':memory:');
    expect(s.getKv('k')).toBeNull();
    s.setKv('k', 'v1');
    s.setKv('k', 'v2');
    expect(s.getKv('k')).toBe('v2');
    s.close();
  });
});
