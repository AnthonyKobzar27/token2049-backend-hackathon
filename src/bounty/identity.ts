// Bounty board <-> worker identity (src/identity): who gets the reputation and which wallet holds it.

import type { Booking } from '../domain/types';
import type { BountyBoard } from './board';

/** Profile id of the worker who actually did a bounty booking (a broadcast bounty may be claimed by a neighbour). */
export function bountyWorkerOf(board: Pick<BountyBoard, 'list'>, booking: Booking): string | undefined {
  if (booking.platform !== 'bounty') return undefined;
  const done = board.list({ bookingId: booking.id }).find((b) => b.workerId && (b.status === 'paid' || b.status === 'verified'));
  return done?.workerId ? `bounty:${done.workerId}` : undefined;
}

/** Binds each verified worker's Cardano payout wallet as their identity wallet, unless one is already bound. */
export function bindBountyWallets(
  board: Pick<BountyBoard, 'listWorkers'>,
  registry: { walletOf(workerId: string): string | undefined; bindWallet(workerId: string, address: string): void },
): number {
  let bound = 0;
  for (const w of board.listWorkers()) {
    const address = w.wallets.cardano;
    const id = `bounty:${w.id}`;
    if (!w.verified || !address || !address.startsWith('addr') || registry.walletOf(id)) continue;
    try {
      registry.bindWallet(id, address);
      bound++;
    } catch (err) {
      console.error(`[bounty] could not bind the wallet of ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  return bound;
}
