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
