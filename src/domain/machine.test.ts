import { describe, expect, it } from 'vitest';
import type { BookingStatus, JobStatus } from './types';
import { assertBookingTransition, assertJobTransition, canBookingTransition, canJobTransition } from './machine';

describe('job machine', () => {
  it('allows the documented transitions', () => {
    const ok: [JobStatus, JobStatus][] = [
      ['awaiting_payment', 'running'], ['awaiting_payment', 'failed'], ['running', 'awaiting_input'], ['running', 'completed'],
      ['running', 'failed'], ['awaiting_input', 'running'], ['awaiting_input', 'completed'], ['awaiting_input', 'failed'],
    ];
    for (const [a, b] of ok) expect(canJobTransition(a, b), `${a}->${b}`).toBe(true);
  });
  it('rejects the rest', () => {
    expect(canJobTransition('awaiting_payment', 'awaiting_input')).toBe(false);
    expect(canJobTransition('completed', 'running')).toBe(false);
    expect(canJobTransition('failed', 'running')).toBe(false);
    expect(canJobTransition('running', 'running')).toBe(false);
    expect(() => assertJobTransition('completed', 'running')).toThrow(/Illegal job transition/);
    expect(() => assertJobTransition('running', 'completed')).not.toThrow();
  });
});

describe('booking machine', () => {
  it('follows the main flow', () => {
    const flow: BookingStatus[] = ['pending_escrow', 'escrowed', 'awaiting_approval', 'placed', 'in_progress', 'delivered', 'in_revision', 'delivered', 'completed'];
    for (let i = 1; i < flow.length; i++) expect(canBookingTransition(flow[i - 1]!, flow[i]!), `${flow[i - 1]}->${flow[i]}`).toBe(true);
    expect(canBookingTransition('awaiting_approval', 'handoff')).toBe(true);
    expect(canBookingTransition('pending_escrow', 'placed')).toBe(false);
  });
  it('lets cancelled and refunded be reached from any non-final state', () => {
    const open: BookingStatus[] = ['pending_escrow', 'escrowed', 'awaiting_approval', 'placed', 'handoff', 'in_progress', 'delivered', 'in_revision'];
    for (const s of open) {
      expect(canBookingTransition(s, 'cancelled')).toBe(true);
      expect(canBookingTransition(s, 'refunded')).toBe(true);
    }
    expect(canBookingTransition('cancelled', 'refunded')).toBe(true);
  });
  it('treats completed and refunded as final', () => {
    for (const to of ['placed', 'cancelled', 'refunded', 'completed'] as const) {
      expect(canBookingTransition('completed', to)).toBe(false);
      expect(canBookingTransition('refunded', to)).toBe(false);
    }
    expect(() => assertBookingTransition('refunded', 'cancelled')).toThrow(/Illegal booking transition/);
  });
});
