import type { Config } from '../config';
import type { EscrowProvider, Store } from '../domain/ports';
import { createMemoryEscrow } from './memory';
import { createSolanaEscrow } from './solana';

export function createEscrowProvider(deps: { store: Store; config: Config }): EscrowProvider {
  const { config } = deps;
  if (config.ESCROW_PROVIDER === 'solana') {
    if (!config.SOLANA_OPERATOR_SECRET) throw new Error('ESCROW_PROVIDER=solana needs SOLANA_OPERATOR_SECRET (base58 secret key of the operator wallet)');
    return createSolanaEscrow(config);
  }
  return createMemoryEscrow();
}
