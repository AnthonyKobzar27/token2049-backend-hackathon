import type { Config } from '../config';
import type { AutonomyPolicy, Store } from '../domain/ports';
import type { ActionClass } from '../domain/types';

/** Only routine messages may be automatic; everything else always needs the operator. */
export function createPolicy(deps: { store: Store; config: Config }): AutonomyPolicy {
  const { store, config } = deps;
  return {
    requiresApproval(action: ActionClass, bookingId?: string): boolean {
      if (action !== 'routine_message') return true;
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
