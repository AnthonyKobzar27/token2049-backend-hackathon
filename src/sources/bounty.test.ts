import { describe, expect, it } from 'vitest';
import { setupBoard, PHYSIO } from '../bounty/testkit';
import { rulesSpec } from '../bounty/spec';
import { testConfig } from '../config';
import type { FreelancerProfile } from '../domain/types';
import { createBountySource } from './bounty';

function setup() {
  const h = setupBoard();
  const source = createBountySource({ board: h.board, store: h.store, config: testConfig({ PUBLIC_URL: 'https://haas.test' }), spec: async (b) => rulesSpec(b) });
  return { ...h, source };
}

describe('bounty source', () => {
  it('lists nearby verified workers, nearest first, priced as the bounty', async () => {
    const { source } = setup();
    expect(source.isEnabled()).toBe(true);
    const found = await source.search(PHYSIO, { limit: 10 });
    expect(found.map((p) => p.id)).toEqual(['bounty:w_ana', 'bounty:w_ben']);
    expect(found[0]).toMatchObject({ platform: 'bounty', verified: true, city: 'Singapore', pricing: [{ kind: 'fixed', amountUsd: 2.22, original: { amount: 3, currency: 'SGD' } }] });
    expect(found[0]!.headline).toMatch(/km from Tanjong Pagar Polyclinic/);
  });

  it('finds nobody for a CAPTCHA-solving brief and refuses to book one', async () => {
    const { source, board } = setup();
    const bad = { ...PHYSIO, task: 'Solve the captcha on the ticket site and book the slot' };
    expect(await source.search(bad, { limit: 10 })).toEqual([]);
    const profile = (await source.search(PHYSIO, { limit: 1 }))[0] as FreelancerProfile;
    await expect(source.book!({ bookingId: 'bk1', profile, brief: bad, priceUsd: 2 })).rejects.toThrow(/does not post tasks that involve solving CAPTCHAs/);
    expect(board.list()).toEqual([]);
  });

  it('maps the bounty lifecycle onto booking status, delivering only checked results', async () => {
    const { source, board } = setup();
    const profile = (await source.search(PHYSIO, { limit: 1 }))[0] as FreelancerProfile;
    const placed = await source.book!({ bookingId: 'bk1', profile, brief: PHYSIO, priceUsd: 2.22 });
    expect(placed).toMatchObject({ kind: 'placed', url: expect.stringMatching(/^https:\/\/haas\.test\/bounty\/bty_/) });
    const ref = placed.platformRef!;
    expect(await source.getBookingStatus!(ref)).toEqual({ status: 'placed' });
    board.claim(ref, 'w_ana');
    expect(await source.getBookingStatus!(ref)).toEqual({ status: 'in_progress' });
    board.submit(ref, 'w_ana', { fields: { date: '2026-10-08', time: '15:00', reference: '88213' }, notes: 'Bring NRIC' });
    expect(await source.getBookingStatus!(ref)).toEqual({ status: 'in_progress' });
    board.verify(ref, { ok: true, issues: [], by: 'rules', at: 1 });
    expect(await source.getBookingStatus!(ref)).toEqual({
      status: 'delivered',
      deliveryText: 'Booked: Thursday 3pm, ref 88213\nNotes: Bring NRIC',
      deliverySummary: 'Booked: Thursday 3pm, ref 88213',
      deliveryData: { date: '2026-10-08', time: '15:00', reference: '88213', notes: 'Bring NRIC' },
    });
    await source.acceptDelivery!(ref);
    expect(await source.getBookingStatus!(ref)).toMatchObject({ status: 'completed', deliverySummary: 'Booked: Thursday 3pm, ref 88213' });
  });

  it('relays messages both ways', async () => {
    const { source, board } = setup();
    const profile = (await source.search(PHYSIO, { limit: 1 }))[0] as FreelancerProfile;
    const { platformRef: ref } = await source.book!({ bookingId: 'bk1', profile, brief: PHYSIO, priceUsd: 2.22 });
    board.claim(ref!, 'w_ana');
    board.addMessage(ref!, 'worker', 'Morning or afternoon?');
    expect((await source.readMessages!(ref!, 0)).map((m) => [m.fromFreelancer, m.text])).toEqual([[true, 'Morning or afternoon?']]);
    await source.sendMessage!(ref!, 'Afternoon');
    expect(board.get(ref!)!.messages.map((m) => m.from)).toEqual(['worker', 'agent']);
  });

  it('expired and rejected bounties read as cancelled', async () => {
    const { source, board, advance } = setup();
    const profile = (await source.search(PHYSIO, { limit: 1 }))[0] as FreelancerProfile;
    const { platformRef: ref } = await source.book!({ bookingId: 'bk1', profile, brief: PHYSIO, priceUsd: 2.22 });
    advance(16 * 60_000);
    board.tick();
    expect(await source.getBookingStatus!(ref!)).toEqual({ status: 'cancelled' });
  });
});
