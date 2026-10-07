// Worker identity and on-chain reputation (Cardano, CIP-68). Entry point used by src/index.ts.

import type { Config } from '../config';
import type { EventBus, Store } from '../domain/ports';
import type { Booking } from '../domain/types';
import type { ReputationChain } from './chain';
import { createCip68Issuer, type CredentialIssuer } from './issuer';
import { createMeshChain } from './mesh';
import { createReputationMinter, type ReputationMinter } from './minter';
import { createIdentityRegistry, type IdentityRegistry } from './registry';

export interface Identity {
  registry: IdentityRegistry;
  minter: ReputationMinter;
  issuer: CredentialIssuer;
  start(): void;
  stop(): void;
}

export const identityConfigured = (c: Config): boolean => Boolean(c.BLOCKFROST_PROJECT_ID && c.CARDANO_MINT_MNEMONIC);

export function createChainFromConfig(config: Config): ReputationChain {
  return createMeshChain({
    network: config.CARDANO_NETWORK,
    mnemonic: config.CARDANO_MINT_MNEMONIC ?? '',
    blockfrostProjectId: config.BLOCKFROST_PROJECT_ID,
    ...(config.IDENTITY_POLICY_LOCK_SLOT !== undefined ? { policyLockSlot: config.IDENTITY_POLICY_LOCK_SLOT } : {}),
  });
}

/** Wires the registry and the minter around a chain. Pass `chain` to override (tests, demos). */
export function createIdentity(deps: { store: Store; bus: EventBus; config: Config; chain?: ReputationChain; workerOf?: (booking: Booking) => string | undefined }): Identity | null {
  const { store, bus, config } = deps;
  if (!deps.chain && !identityConfigured(config)) return null;
  const chain = deps.chain ?? createChainFromConfig(config);
  const issuer = createCip68Issuer(chain);
  const registry = createIdentityRegistry({ store, chain, issuer });
  const minter = createReputationMinter(
    { store, bus, registry, ...(deps.workerOf && { workerOf: deps.workerOf }) },
    {
      verifyGraceMs: config.IDENTITY_VERIFY_GRACE_MIN * 60_000,
      requireVerification: config.IDENTITY_REQUIRE_VERIFICATION,
      receipts: config.IDENTITY_RECEIPTS,
    },
  );
  return {
    registry,
    minter,
    issuer,
    start() {
      minter.start();
      registry.warm();
    },
    stop() {
      minter.stop();
    },
  };
}

export type { OnChainSignal, WorkerCredential, Reputation, JobReceipt } from './types';
