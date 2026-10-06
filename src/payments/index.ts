import type { Config } from '../config';
import type { EscrowProvider, Store } from '../domain/ports';
import { createMemoryEscrow } from './memory';
import { createSolanaEscrow } from './solana';
import { createSolanaProgramEscrow } from './solana-program';

export function createEscrowProvider(deps: { store: Store; config: Config }): EscrowProvider {
  const { config } = deps;
  const kind = config.ESCROW_PROVIDER;
  if (kind === 'memory') return createMemoryEscrow();
  if (!config.SOLANA_OPERATOR_SECRET) throw new Error(`ESCROW_PROVIDER=${kind} needs SOLANA_OPERATOR_SECRET (base58 secret key of the operator wallet)`);
  // On-chain program escrow: the hirer's funds sit in a program-owned PDA with a refund deadline.
  if (kind === 'solana-program') return createSolanaProgramEscrow(config);
  // 'solana-vault' and legacy 'solana': server-held vault wallet, kept as a fallback.
  return createSolanaEscrow(config);
}
