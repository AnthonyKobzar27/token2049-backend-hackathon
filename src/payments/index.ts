// Escrow provider selection. The memory provider is real (it just holds no
// actual funds): deposits are instant, release and refund only move status.
// The Solana provider is not written yet; selecting it falls back with a warning.

import type { Config } from '../config';
import { newId, now } from '../domain/ids';
import type { EscrowProvider, Store } from '../domain/ports';
import type { EscrowRecord } from '../domain/types';

export function createEscrowProvider(deps: { store: Store; config: Config }): EscrowProvider {
  if (deps.config.ESCROW_PROVIDER === 'solana') {
    console.warn('[escrow] solana provider is not implemented yet; using the memory provider');
  }
  return createMemoryEscrow();
}

function createMemoryEscrow(): EscrowProvider {
  return {
    name: 'memory',
    currency: 'USD',
    async create({ bookingId, amountUsd }) {
      const t = now();
      const escrow: EscrowRecord = {
        id: newId('esc'),
        bookingId,
        provider: 'memory',
        status: 'funded',
        amount: amountUsd,
        currency: 'USD',
        createdAt: t,
        updatedAt: t,
      };
      return escrow;
    },
    async refresh(escrow) {
      return escrow;
    },
    async release(escrow) {
      return { ...escrow, status: 'released', updatedAt: now() };
    },
    async refund(escrow) {
      return { ...escrow, status: 'refunded', updatedAt: now() };
    },
  };
}
