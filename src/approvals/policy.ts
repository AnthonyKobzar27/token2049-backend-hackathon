import type { Config } from '../config';
import type { AutonomyPolicy, Store } from '../domain/ports';
import type { ActionClass, Booking } from '../domain/types';

/**
 * Routine messages may be automatic. Two QA steps may be too, and only while the booking is not paused:
 * - 'revise' for the one revision after a failed automatic QA run (AUTO_QA_REVISION, on by default);
 * - 'accept' (escrow release) after QA passed, for bookings up to AUTO_RELEASE_MAX_USD (off by default).
 * Everything else always needs the operator.
 */
export function createPolicy(deps: { store: Store; config: Config }): AutonomyPolicy {
  const { store, config } = deps;

  function autoQa(action: ActionClass, b: Booking): boolean {
    const qa = b.verification;
    if (!qa) return false;
    if (action === 'revise') return config.AUTO_QA_REVISION && b.status === 'verifying' && qa.verdict === 'fail' && qa.checks.every((c) => c.by !== 'human');
    if (action === 'accept') return config.AUTO_RELEASE_MAX_USD > 0 && b.status === 'verified' && qa.verdict === 'pass' && b.priceUsd <= config.AUTO_RELEASE_MAX_USD;
    return false;
  }

  return {
    requiresApproval(action: ActionClass, bookingId?: string): boolean {
      if (action !== 'routine_message') {
        const b = bookingId ? store.getBooking(bookingId) : null;
        return !(b && !b.paused && autoQa(action, b));
      }
      if (config.REQUIRE_APPROVAL_FOR_ROUTINE_MESSAGES) return true;
      if (bookingId && store.getBooking(bookingId)?.paused) return true;
      return false;
    },
    pause(bookingId: string): void {
      store.updateBooking(bookingId, { paused: true });
    },
    resume(bookingId: string): void {
      store.updateBooking(bookingId, { paused: false });
    },
  };
}
