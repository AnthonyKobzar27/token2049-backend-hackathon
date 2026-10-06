// Worker identity and reputation types. Local to src/identity; the rest of the app only sees
// OnChainSignal (src/router/match.ts) and the JSON returned by GET /workers/:id/reputation.

import type { Ms } from '../domain/types';

export type CardanoNetwork = 'preprod' | 'mainnet';

/** The "HAAS Verified Worker" credential: a CIP-68 pair under the HAAS policy. */
export interface WorkerCredential {
  workerId: string;
  /** Wallet the credential is bound to (the user token is sent here and must stay here). */
  walletAddress: string;
  issuer: 'cip68' | (string & {});
  network: CardanoNetwork;
  policyId: string;
  /** Hex asset name without the CIP-68 label. */
  assetName: string;
  /** policyId + (100) label + name: the reference NFT, held by the operator, carries the datum. */
  refUnit: string;
  /** policyId + (222) label + name: the user NFT in the worker's wallet. */
  userUnit: string;
  txHash: string;
  issuedAt: Ms;
}

/** Running totals, mirrored in the reference NFT's inline datum. */
export interface Reputation {
  jobsCompleted: number;
  /** Jobs whose result passed QA verification. */
  verifiedJobs: number;
  ratedJobs: number;
  ratingSum: number;
  totalEarnedUsd: number;
  lastJobId?: string;
  lastBookingId?: string;
  lastResultHash?: string;
  lastPaymentTx?: string;
  lastReceiptUnit?: string;
  /** Hash of the transaction that last updated the datum (the previous link of the chain). */
  lastUpdateTx?: string;
  updatedAt?: Ms;
}

export const emptyReputation = (): Reputation => ({ jobsCompleted: 0, verifiedJobs: 0, ratedJobs: 0, ratingSum: 0, totalEarnedUsd: 0 });

export const avgRating = (r: Reputation): number | undefined => (r.ratedJobs > 0 ? Math.round((r.ratingSum / r.ratedJobs) * 100) / 100 : undefined);

/** One completed, paid job, as recorded on chain. */
export interface JobReceipt {
  workerId: string;
  bookingId: string;
  jobId: string;
  /** Masumi blockchainIdentifier or HAAS job id the purchaser knows. */
  masumiJobId?: string;
  resultHash: string;
  resultHashKind: 'qa' | 'masumi-mip004' | 'booking';
  qaPassed: boolean | null;
  paymentTx?: string;
  paymentKind?: 'masumi-collection' | 'escrow-settle' | 'escrow-deposit' | 'masumi-blockchain-id';
  priceUsd: number;
  rating?: number;
  /** CIP-25 receipt NFT unit, when receipts are minted. */
  receiptUnit?: string;
  txHash: string;
  at: Ms;
}

/** What the router needs: cheap, synchronous, from cache. Defined next to the ranking code. */
export type { OnChainSignal } from '../router/match';

/** Inbound events other modules may emit on the bus. Matched structurally so src/domain/types.ts stays untouched. */
export interface VerificationEvent {
  type: 'verification.completed';
  bookingId: string;
  jobId?: string;
  passed: boolean;
  resultHash: string;
  /** 0 to 5. */
  rating?: number;
}

export interface PaymentCollectedEvent {
  type: 'payment.collected';
  jobId: string;
  txHash: string;
  bookingId?: string;
}

export function isVerificationEvent(e: unknown): e is VerificationEvent {
  const x = e as Partial<VerificationEvent> | null;
  return !!x && x.type === 'verification.completed' && typeof x.bookingId === 'string' && typeof x.passed === 'boolean' && typeof x.resultHash === 'string';
}

export function isPaymentCollectedEvent(e: unknown): e is PaymentCollectedEvent {
  const x = e as Partial<PaymentCollectedEvent> | null;
  return !!x && x.type === 'payment.collected' && typeof x.jobId === 'string' && typeof x.txHash === 'string';
}
