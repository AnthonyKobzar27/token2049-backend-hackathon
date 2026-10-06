import { describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { createBountyBoard } from './board';
import { setupBoard } from './testkit';

const RESULT = { fields: { date: '2026-10-08', time: '15:00', reference: '88213' }, notes: 'Bring NRIC' };

describe('bounty board', () => {
  it('offers a broadcast bounty to nearby verified workers only, nearest first', () => {
    const h = setupBoard();
    const b = h.post();
    expect(b.status).toBe('posted');
    expect(b.offers.map((o) => o.workerId)).toEqual(['w_ana', 'w_ben']); // Cat is >15 km, Dan unverified
    expect(h.notifier.sent.filter((s) => s.notice.kind === 'offer').map((s) => s.worker)).toEqual(['w_ana', 'w_ben']);
    expect(h.notifier.sent[0]!.notice.url).toMatch(/^https:\/\/haas\.test\/w\//);
    expect(h.events.map((e) => e.status)).toEqual(['posted']);
  });

  it('direct mode offers only the chosen worker and refuses unverified ones', () => {
    const h = setupBoard({ BOUNTY_MODE: 'direct' });
    expect(h.post({ workerId: 'w_cat' }).offers.map((o) => o.workerId)).toEqual(['w_cat']);
    expect(() => h.post({ workerId: 'w_dan' })).toThrow(/not verified/);
  });

  it('runs the full lifecycle: claim, submit, verify and pay', async () => {
    const h = setupBoard();
    const b = h.post({ bookingId: 'bk1', jobId: 'j1' });
    const c = h.board.claim(b.id, 'w_ana');
    expect(c.ok && c.bounty.status).toBe('claimed');
    expect(c.ok && c.bounty.submitBy).toBe(h.now() + 60 * 60_000);
    expect(h.notifier.sent.some((s) => s.worker === 'w_ben' && s.notice.kind === 'taken')).toBe(true);

    expect(h.board.submit(b.id, 'w_ben', RESULT)).toMatchObject({ ok: false });
    const bad = h.board.submit(b.id, 'w_ana', { fields: { date: '2026-10-08' } });
    expect(bad.ok).toBe(false);
    const s = h.board.submit(b.id, 'w_ana', RESULT);
    expect(s.ok && s.bounty.result).toMatchObject({ summary: 'Booked: Thursday 3pm, ref 88213', data: RESULT.fields, notes: 'Bring NRIC' });

    const p = await h.board.verifyAndPay(b.id);
    expect(p.ok && p.bounty).toMatchObject({ status: 'paid', payout: { chain: 'solana', address: 'SoLAna111', ref: 'tx1' } });
    expect(h.paid).toEqual([`w_ana:${b.id}`]);
    expect(h.board.getWorker('w_ana')!.completed).toBe(1);
    expect(h.events.map((e) => e.status)).toEqual(['posted', 'claimed', 'submitted', 'verified', 'paid']);
    expect(h.events.at(-1)).toMatchObject({ bookingId: 'bk1', jobId: 'j1', workerId: 'w_ana' });
    // paying twice is a no-op
    expect((await h.board.verifyAndPay(b.id)).ok).toBe(true);
    expect(h.paid).toHaveLength(1);
  });

  it('lets exactly one of many concurrent claimers win', async () => {
    const h = setupBoard({ BOUNTY_BROADCAST_MAX: 5, BOUNTY_RADIUS_KM: 50 });
    const b = h.post();
    const ids = b.offers.map((o) => o.workerId);
    expect(ids.length).toBe(3);
    const results = await Promise.all(ids.flatMap((id) => [0, 1, 2].map(() => Promise.resolve().then(() => h.board.claim(b.id, id)))));
    const winners = new Set(results.filter((r) => r.ok).map((r) => (r.ok ? r.bounty.workerId : '')));
    expect(winners.size).toBe(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && /already claimed/.test(r.error))).toBe(true);
    expect(h.events.filter((e) => e.status === 'claimed')).toHaveLength(1);
  });

  it('refuses claims from workers the bounty was not offered to', () => {
    const h = setupBoard();
    const b = h.post();
    expect(h.board.claim(b.id, 'w_cat')).toEqual({ ok: false, error: 'This task was not offered to you' });
  });

  it('expires an unclaimed bounty after the claim window', () => {
    const h = setupBoard({ BOUNTY_CLAIM_MIN: 10 });
    const b = h.post({ bookingId: 'bk2' });
    h.advance(9 * 60_000);
    expect(h.board.tick()).toEqual([]);
    h.advance(2 * 60_000);
    expect(h.board.claim(b.id, 'w_ana')).toMatchObject({ ok: false, error: 'This task has expired' });
    const expired = h.board.tick();
    expect(expired.map((x) => x.id)).toEqual([b.id]);
    expect(h.events.at(-1)).toMatchObject({ status: 'expired', stage: 'claim', bookingId: 'bk2', rewardUsd: 2.22 });
    expect(h.notifier.sent.filter((s) => s.notice.kind === 'expired')).toHaveLength(2);
  });

  it('expires a claimed bounty not submitted by the deadline', () => {
    const h = setupBoard({ BOUNTY_SUBMIT_MIN: 30 });
    const b = h.post();
    h.board.claim(b.id, 'w_ana');
    h.advance(31 * 60_000);
    h.board.tick();
    expect(h.board.get(b.id)!.status).toBe('expired');
    expect(h.events.at(-1)).toMatchObject({ status: 'expired', stage: 'submit', workerId: 'w_ana' });
    expect(h.board.submit(b.id, 'w_ana', RESULT).ok).toBe(false);
  });

  it('sends a revision back to the worker with a fresh deadline, then accepts the fix', async () => {
    const h = setupBoard();
    const b = h.post();
    h.board.claim(b.id, 'w_ana');
    h.board.submit(b.id, 'w_ana', RESULT);
    h.advance(5 * 60_000);
    const r = h.board.requestRevision(b.id, 'Reference must be the clinic one');
    expect(r.ok && r.bounty).toMatchObject({ status: 'claimed', feedback: 'Reference must be the clinic one', submitBy: h.now() + 60 * 60_000 });
    expect(h.board.submit(b.id, 'w_ana', { fields: { ...RESULT.fields, reference: 'TPP-88213' } }).ok).toBe(true);
    expect(h.board.get(b.id)!.feedback).toBeUndefined();
    expect((await h.board.verifyAndPay(b.id)).ok).toBe(true);
  });

  it('sends a checked (verified) submission back when the booking QA or the hirer turns it down', () => {
    const h = setupBoard();
    const b = h.post();
    h.board.claim(b.id, 'w_ana');
    h.board.submit(b.id, 'w_ana', RESULT);
    expect(h.board.verify(b.id, { ok: true, issues: [], by: 'rules', at: h.now() }).ok).toBe(true);
    const r = h.board.requestRevision(b.id, 'The clinic has no booking 88213');
    expect(r.ok && r.bounty).toMatchObject({ status: 'claimed', revisions: 1, feedback: 'The clinic has no booking 88213' });
    expect(h.notifier.sent.some((s) => s.worker === 'w_ana' && s.notice.kind === 'revision')).toBe(true);
  });

  it('rejects and cancels', () => {
    const h = setupBoard();
    const a = h.post();
    h.board.claim(a.id, 'w_ana');
    expect(h.board.reject(a.id, 'nope').ok).toBe(false); // not submitted yet
    h.board.submit(a.id, 'w_ana', RESULT);
    expect(h.board.reject(a.id, 'wrong clinic')).toMatchObject({ ok: true, bounty: { status: 'rejected', reason: 'wrong clinic' } });
    const c = h.post();
    expect(h.board.cancel(c.id, 'hirer cancelled')).toMatchObject({ ok: true, bounty: { status: 'cancelled' } });
    expect(h.board.claim(c.id, 'w_ana').ok).toBe(false);
  });

  it('keeps a payout failure retryable', async () => {
    const h = setupBoard();
    let fail = true;
    const board = createBountyBoard({ store: h.store, bus: h.bus, config: testConfig(), notifier: h.notifier, now: h.now, payout: { pay: async () => { if (fail) throw new Error('rpc down'); return { chain: 'none' }; } } });
    const b = h.post();
    board.claim(b.id, 'w_ana');
    board.submit(b.id, 'w_ana', RESULT);
    expect(await board.verifyAndPay(b.id)).toEqual({ ok: false, error: 'payout failed: rpc down' });
    expect(board.get(b.id)!.status).toBe('verified');
    fail = false;
    expect((await board.verifyAndPay(b.id)).ok && board.get(b.id)!.status).toBe('paid');
  });

  it('links a Telegram chat by code and finds bounties by code and token', () => {
    const h = setupBoard();
    const ana = h.board.getWorker('w_ana')!;
    expect(h.board.linkTelegram('wrong', '42')).toBeNull();
    expect(h.board.linkTelegram(ana.linkCode, '42')!.contact.telegramId).toBe('42');
    expect(h.board.workerByTelegram('42')!.id).toBe('w_ana');
    const b = h.post();
    expect(h.board.byCode(b.code.toLowerCase())!.id).toBe(b.id);
    expect(h.board.byToken(b.offers[0]!.token)).toMatchObject({ bounty: { id: b.id }, worker: { id: 'w_ana' } });
    expect(h.board.byToken('nope')).toBeNull();
  });

  it('records messages both ways and notifies the worker of agent messages', () => {
    const h = setupBoard();
    const b = h.post();
    h.board.claim(b.id, 'w_ana');
    h.board.addMessage(b.id, 'worker', 'Which name for the booking?');
    h.board.addMessage(b.id, 'agent', 'Use Lee Wei');
    expect(h.board.get(b.id)!.messages.map((m) => m.from)).toEqual(['worker', 'agent']);
    expect(h.notifier.sent.at(-1)!.notice).toMatchObject({ kind: 'message' });
  });
});
