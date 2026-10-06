// In-memory escrow for local development: no chain, deposits are instant.

import { newId, now } from '../domain/ids';
import type { EscrowProvider } from '../domain/ports';
import type { EscrowRecord } from '../domain/types';

export function createMemoryEscrow(): EscrowProvider {
  const touch = (e: EscrowRecord, patch: Partial<EscrowRecord>): EscrowRecord => ({ ...e, ...patch, updatedAt: now() });
  return {
    name: 'memory',
    currency: 'USDC',
    async create({ bookingId, amountUsd }) {
      const t = now();
      return {
        id: newId('esc'),
        bookingId,
        provider: 'memory',
        status: 'funded',
        amount: amountUsd,
        currency: 'USDC',
        payer: 'memory-payer',
        createdAt: t,
        updatedAt: t,
      };
    },
    async refresh(escrow) {
      return escrow;
    },
    async release(escrow, opts = {}) {
      return touch(escrow, { status: 'released', ...(opts.resultHash ? { resultHash: opts.resultHash } : {}) });
    },
    async refund(escrow) {
      return touch(escrow, { status: 'refunded' });
    },
  };
}
