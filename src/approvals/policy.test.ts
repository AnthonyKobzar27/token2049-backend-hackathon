import { describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import type { Store } from '../domain/ports';
import type { ActionClass, Booking } from '../domain/types';
import { createPolicy } from './policy';

export function fakeBookingStore(initial: Partial<Booking> = {}) {
  const booking = { id: 'bk_1', paused: false, ...initial } as Booking;
  const store = {
    getBooking: (id: string) => (id === booking.id ? booking : null),
    updateBooking: (_id: string, patch: Partial<Booking>) => Object.assign(booking, patch),
  } as unknown as Store;
  return { store, booking };
}

const ACTIONS: ActionClass[] = ['routine_message', 'first_contact', 'book', 'pay', 'accept', 'revise', 'cancel', 'extra'];

describe('policy', () => {
  it('only routine messages can be automatic', () => {
    const { store } = fakeBookingStore();
    const p = createPolicy({ store, config: testConfig({ REQUIRE_APPROVAL_FOR_ROUTINE_MESSAGES: false }) });
    for (const a of ACTIONS) expect(p.requiresApproval(a, 'bk_1')).toBe(a !== 'routine_message');
    expect(p.requiresApproval('routine_message')).toBe(false);
  });

  it('requires approval for routine messages when configured', () => {
    const { store } = fakeBookingStore();
    const p = createPolicy({ store, config: testConfig({ REQUIRE_APPROVAL_FOR_ROUTINE_MESSAGES: true }) });
    expect(p.requiresApproval('routine_message', 'bk_1')).toBe(true);
  });

  it('pause and resume change the booking', () => {
    const { store, booking } = fakeBookingStore();
    const p = createPolicy({ store, config: testConfig() });
    p.pause('bk_1');
    expect(booking.paused).toBe(true);
    expect(p.requiresApproval('routine_message', 'bk_1')).toBe(true);
    p.resume('bk_1');
    expect(p.requiresApproval('routine_message', 'bk_1')).toBe(false);
  });
});

describe('policy: QA autonomy', () => {
  const qa = (verdict: 'pass' | 'fail', by: 'llm' | 'human' = 'llm') =>
    ({ verdict, score: 1, checks: [{ name: 'c', ok: verdict === 'pass', detail: '', by }], summary: '', resultHash: 'h', deliveryHash: 'd', attempt: 1, ms: 1, at: 1 }) as Booking['verification'];

  it('auto-releases a passed booking only under AUTO_RELEASE_MAX_USD and while not paused', () => {
    const { store, booking } = fakeBookingStore({ status: 'verified', priceUsd: 20, verification: qa('pass') });
    const on = createPolicy({ store, config: testConfig({ AUTO_RELEASE_MAX_USD: 25 }) });
    expect(on.requiresApproval('accept', 'bk_1')).toBe(false);
    booking.priceUsd = 30;
    expect(on.requiresApproval('accept', 'bk_1')).toBe(true);
    booking.priceUsd = 20;
    on.pause('bk_1');
    expect(on.requiresApproval('accept', 'bk_1')).toBe(true);
    const off = createPolicy({ store: fakeBookingStore({ status: 'verified', priceUsd: 20, verification: qa('pass') }).store, config: testConfig() });
    expect(off.requiresApproval('accept', 'bk_1')).toBe(true);
    const failed = createPolicy({ store: fakeBookingStore({ status: 'verified', priceUsd: 1, verification: qa('fail') }).store, config: testConfig({ AUTO_RELEASE_MAX_USD: 25 }) });
    expect(failed.requiresApproval('accept', 'bk_1')).toBe(true);
  });

  it('auto-requests the QA revision only for an automatic failure', () => {
    const p = (b: Partial<Booking>, o = {}) => createPolicy({ store: fakeBookingStore(b).store, config: testConfig(o) });
    expect(p({ status: 'verifying', verification: qa('fail') }).requiresApproval('revise', 'bk_1')).toBe(false);
    expect(p({ status: 'verifying', verification: qa('fail') }, { AUTO_QA_REVISION: false }).requiresApproval('revise', 'bk_1')).toBe(true);
    expect(p({ status: 'verified', verification: qa('fail', 'human') }).requiresApproval('revise', 'bk_1')).toBe(true);
    expect(p({ status: 'delivered' }).requiresApproval('revise', 'bk_1')).toBe(true);
  });
});
