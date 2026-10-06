// Client codec for the haas-escrow Anchor program (programs/haas-escrow).
// Hand-written against the IDL (programs/haas-escrow/idl/haas_escrow.json) so the
// server needs no Anchor runtime; a unit test checks the discriminators match the IDL.

import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';

export const DEFAULT_ESCROW_PROGRAM_ID = '9hzyeY6LPaQzJWszBjtYU17sHN2XmQD6FmyJFCNrs727';
const ESCROW_SEED = Buffer.from('escrow');

const sha256 = (s: string | Uint8Array): Buffer => createHash('sha256').update(s).digest();
/** Anchor discriminator: first 8 bytes of sha256("<namespace>:<name>"). */
export const discriminator = (namespace: 'global' | 'account' | 'event', name: string): Buffer => sha256(`${namespace}:${name}`).subarray(0, 8);

export const IX = {
  initializeAndDeposit: discriminator('global', 'initialize_and_deposit'),
  release: discriminator('global', 'release'),
  refund: discriminator('global', 'refund'),
  cancel: discriminator('global', 'cancel'),
} as const;
export const ESCROW_ACCOUNT_DISCRIMINATOR = discriminator('account', 'Escrow');

export const ZERO_HASH = new Uint8Array(32);

/** 32-byte booking hash used in the escrow PDA seeds. */
export const bookingHash = (bookingId: string): Buffer => sha256(bookingId);

/**
 * Normalises a delivery result hash: a 64-char hex string is used as is,
 * anything else (a delivery text, URL list, JSON verdict) is sha256-hashed.
 */
export function toResultHash(input?: string | Uint8Array): Uint8Array {
  if (input === undefined || input === '') return ZERO_HASH;
  if (input instanceof Uint8Array) {
    if (input.length !== 32) throw new Error(`result hash must be 32 bytes, got ${input.length}`);
    return input;
  }
  if (/^[0-9a-f]{64}$/i.test(input)) return Buffer.from(input, 'hex');
  return sha256(input);
}
export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

export function escrowPda(programId: PublicKey, authority: PublicKey, bookingId: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([ESCROW_SEED, authority.toBuffer(), bookingHash(bookingId)], programId);
}
export const vaultAddress = (mint: PublicKey, escrow: PublicKey, tokenProgram = TOKEN_PROGRAM_ID): PublicKey =>
  getAssociatedTokenAddressSync(mint, escrow, true, tokenProgram);

// ------------------------------------------------------------- instructions

const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const i64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(v);
  return b;
};
const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });

export interface DepositArgs {
  programId: PublicKey;
  hirer: PublicKey;
  authority: PublicKey;
  payee: PublicKey;
  mint: PublicKey;
  bookingId: string;
  amount: bigint;
  /** Unix seconds. */
  deadline: bigint;
  expectedResultHash?: Uint8Array;
  hirerToken?: PublicKey;
  tokenProgram?: PublicKey;
}

export function initializeAndDepositIx(a: DepositArgs): TransactionInstruction {
  const tokenProgram = a.tokenProgram ?? TOKEN_PROGRAM_ID;
  const [escrow] = escrowPda(a.programId, a.authority, a.bookingId);
  const hirerToken = a.hirerToken ?? getAssociatedTokenAddressSync(a.mint, a.hirer, true, tokenProgram);
  return new TransactionInstruction({
    programId: a.programId,
    keys: [
      { pubkey: a.hirer, isSigner: true, isWritable: true },
      r(a.authority),
      r(a.payee),
      r(a.mint),
      w(hirerToken),
      w(escrow),
      w(vaultAddress(a.mint, escrow, tokenProgram)),
      r(tokenProgram),
      r(ASSOCIATED_TOKEN_PROGRAM_ID),
      r(SystemProgram.programId),
    ],
    data: Buffer.concat([IX.initializeAndDeposit, bookingHash(a.bookingId), u64(a.amount), i64(a.deadline), Buffer.from(a.expectedResultHash ?? ZERO_HASH)]),
  });
}

interface SettleArgs {
  programId: PublicKey;
  signer: PublicKey;
  escrow: PublicKey;
  hirer: PublicKey;
  mint: PublicKey;
  /** Destination token account: the payee's (release) or the hirer's (refund, cancel). */
  destination: PublicKey;
  tokenProgram?: PublicKey;
}

function settleKeys(a: SettleArgs) {
  const tokenProgram = a.tokenProgram ?? TOKEN_PROGRAM_ID;
  return [
    { pubkey: a.signer, isSigner: true, isWritable: false },
    w(a.escrow),
    w(a.hirer),
    r(a.mint),
    w(vaultAddress(a.mint, a.escrow, tokenProgram)),
    w(a.destination),
    r(tokenProgram),
  ];
}

export const releaseIx = (a: SettleArgs & { resultHash?: Uint8Array }): TransactionInstruction =>
  new TransactionInstruction({ programId: a.programId, keys: settleKeys(a), data: Buffer.concat([IX.release, Buffer.from(a.resultHash ?? ZERO_HASH)]) });
export const refundIx = (a: SettleArgs): TransactionInstruction => new TransactionInstruction({ programId: a.programId, keys: settleKeys(a), data: Buffer.from(IX.refund) });
export const cancelIx = (a: SettleArgs): TransactionInstruction => new TransactionInstruction({ programId: a.programId, keys: settleKeys(a), data: Buffer.from(IX.cancel) });

// ------------------------------------------------------------------ account

export type OnchainEscrowStatus = 'funded' | 'released' | 'refunded' | 'cancelled';
const STATUSES: OnchainEscrowStatus[] = ['funded', 'released', 'refunded', 'cancelled'];

export interface OnchainEscrow {
  authority: PublicKey;
  hirer: PublicKey;
  payee: PublicKey;
  mint: PublicKey;
  bookingHash: Uint8Array;
  amount: bigint;
  deadline: bigint;
  createdAt: bigint;
  expectedResultHash: Uint8Array;
  resultHash: Uint8Array;
  status: OnchainEscrowStatus;
  bump: number;
}

export const ESCROW_ACCOUNT_SIZE = 8 + 32 * 5 + 8 * 3 + 32 * 2 + 1 + 1;

export function decodeEscrow(data: Uint8Array): OnchainEscrow {
  const b = Buffer.from(data);
  if (b.length < ESCROW_ACCOUNT_SIZE) throw new Error(`escrow account too short: ${b.length} bytes`);
  if (!b.subarray(0, 8).equals(ESCROW_ACCOUNT_DISCRIMINATOR)) throw new Error('not a haas-escrow Escrow account');
  let o = 8;
  const key = () => new PublicKey(b.subarray(o, (o += 32)));
  const bytes = () => new Uint8Array(b.subarray(o, (o += 32)));
  const authority = key(), hirer = key(), payee = key(), mint = key();
  const bh = bytes();
  const amount = b.readBigUInt64LE(o); o += 8;
  const deadline = b.readBigInt64LE(o); o += 8;
  const createdAt = b.readBigInt64LE(o); o += 8;
  const expectedResultHash = bytes();
  const resultHash = bytes();
  const status = STATUSES[b[o++]!];
  if (!status) throw new Error(`unknown escrow status ${b[o - 1]}`);
  const bump = b[o]!;
  return { authority, hirer, payee, mint, bookingHash: bh, amount, deadline, createdAt, expectedResultHash, resultHash, status, bump };
}

/** Inverse of decodeEscrow, for tests and fixtures. */
export function encodeEscrow(e: OnchainEscrow): Buffer {
  return Buffer.concat([
    ESCROW_ACCOUNT_DISCRIMINATOR,
    e.authority.toBuffer(), e.hirer.toBuffer(), e.payee.toBuffer(), e.mint.toBuffer(),
    Buffer.from(e.bookingHash), u64(e.amount), i64(e.deadline), i64(e.createdAt),
    Buffer.from(e.expectedResultHash), Buffer.from(e.resultHash),
    Buffer.from([STATUSES.indexOf(e.status), e.bump]),
  ]);
}
