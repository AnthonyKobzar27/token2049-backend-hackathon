// Booking-budget escrow held by the haas-escrow program on Solana (programs/haas-escrow).
//
// The hirer's wallet signs one transaction (built here, delivered as a Solana Pay
// transaction request) that creates the escrow PDA for the booking and moves the
// USDC into its vault. HAAS (the operator key, the escrow's `authority`) can then
// release to the payee or cancel back to the hirer; after the on-chain deadline
// anyone can refund the hirer, so the money never depends on this server.

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type AccountInfo,
  type TransactionInstruction,
} from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, unpackMint } from '@solana/spl-token';
import type { Config } from '../config';
import { newId, now as clockNow } from '../domain/ids';
import type { EscrowProvider } from '../domain/ports';
import type { EscrowRecord, EscrowTx } from '../domain/types';
import {
  cancelIx,
  decodeEscrow,
  escrowPda,
  hex,
  initializeAndDepositIx,
  refundIx,
  releaseIx,
  toResultHash,
  type OnchainEscrow,
} from './escrow-program';
import { decodeOperatorSecret, fromBaseUnits, isExpired, rpc, toBaseUnits } from './solana';

export const PROVIDER_NAME = 'solana-program';

/** The subset of web3.js Connection this provider uses (tests pass a fake). */
export type EscrowConnection = Pick<
  Connection,
  'getAccountInfo' | 'getLatestBlockhash' | 'sendRawTransaction' | 'confirmTransaction' | 'getSignaturesForAddress'
>;

export interface SolanaProgramEscrowOptions {
  connection?: EscrowConnection;
  /** Epoch ms; injectable for tests. */
  now?: () => number;
}

export type SolanaProgramEscrow = EscrowProvider & {
  readonly programId: PublicKey;
  readonly operator: PublicKey;
  escrowAddress(bookingId: string): PublicKey;
  /** Reads and decodes the escrow account; null when it does not exist yet. */
  fetchOnchain(bookingId: string): Promise<OnchainEscrow | null>;
  buildDepositTransaction(escrow: EscrowRecord, account: string): Promise<{ transaction: string; message: string }>;
};

/** Seconds of clock skew tolerated before using the permissionless refund instead of cancel. */
const SKEW_S = 30;

export function explorerTx(sig: string, rpcUrl: string): string {
  const c = rpcUrl.includes('devnet') ? '?cluster=devnet' : rpcUrl.includes('testnet') ? '?cluster=testnet' : '';
  return `https://explorer.solana.com/tx/${sig}${c}`;
}

/** Solana Pay transaction request link: the wallet fetches the transaction from `endpoint`. */
export const transactionRequestUrl = (endpoint: string): string => `solana:${encodeURIComponent(endpoint)}`;

export function createSolanaProgramEscrow(config: Config, opts: SolanaProgramEscrowOptions = {}): SolanaProgramEscrow {
  if (!config.SOLANA_OPERATOR_SECRET) throw new Error('SOLANA_OPERATOR_SECRET is not set');
  const operator: Keypair = decodeOperatorSecret(config.SOLANA_OPERATOR_SECRET);
  const programId = new PublicKey(config.SOLANA_ESCROW_PROGRAM_ID);
  const mint = new PublicKey(config.SOLANA_USDC_MINT);
  const connection: EscrowConnection = opts.connection ?? new Connection(config.SOLANA_RPC_URL, 'confirmed');
  const now = opts.now ?? clockNow;
  const explorer = (sig: string) => explorerTx(sig, config.SOLANA_RPC_URL);
  const pda = (bookingId: string) => escrowPda(programId, operator.publicKey, bookingId)[0];

  let mintP: Promise<{ decimals: number; tokenProgram: PublicKey }> | undefined;
  const mintInfo = () =>
    (mintP ??= rpc('reading the mint', async () => {
      const info = await connection.getAccountInfo(mint, 'confirmed');
      if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
      return { decimals: unpackMint(mint, info, info.owner).decimals, tokenProgram: info.owner };
    }).catch((e) => ((mintP = undefined), Promise.reject(e))));

  async function fetchOnchain(bookingId: string): Promise<OnchainEscrow | null> {
    const info: AccountInfo<Buffer> | null = await rpc('reading the escrow account', () => connection.getAccountInfo(pda(bookingId), 'confirmed'));
    if (!info) return null;
    if (!info.owner.equals(programId)) throw new Error(`escrow account ${pda(bookingId).toBase58()} is not owned by the escrow program`);
    return decodeEscrow(info.data);
  }

  /** Operator signs and pays the fee; retries once on blockhash expiry. */
  async function send(what: string, ixs: TransactionInstruction[]): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await rpc(what, async () => {
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
          const tx = new Transaction({ feePayer: operator.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
          tx.sign(operator);
          const sig = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
          const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
          if (res.value.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
          return sig;
        });
      } catch (e) {
        if (attempt === 0 && isExpired(e)) continue;
        throw e;
      }
    }
  }

  const touch = (e: EscrowRecord, patch: Partial<EscrowRecord>): EscrowRecord => ({ ...e, ...patch, updatedAt: now() });
  const withTx = (e: EscrowRecord, kind: EscrowTx['kind'], signature: string): Partial<EscrowRecord> => ({
    txs: [...(e.txs ?? []).filter((t) => t.signature !== signature), { kind, signature, url: explorer(signature), at: now() }],
    explorerUrl: explorer(signature),
  });

  /** Why an on-chain escrow does not match what this booking expects, or null when it does. */
  async function mismatch(e: EscrowRecord, on: OnchainEscrow): Promise<string | null> {
    const { decimals } = await mintInfo();
    if (!on.mint.equals(mint)) return `deposit is in mint ${on.mint.toBase58()}, expected ${mint.toBase58()}`;
    if (on.amount < toBaseUnits(e.amount, decimals)) return `deposit is ${fromBaseUnits(on.amount, decimals)} ${e.currency}, expected ${e.amount}`;
    if (e.payee && on.payee.toBase58() !== e.payee) return `escrow pays ${on.payee.toBase58()}, expected ${e.payee}`;
    if (e.deadline && Number(on.deadline) * 1000 < e.deadline - SKEW_S * 1000) return `escrow deadline ${new Date(Number(on.deadline) * 1000).toISOString()} is earlier than agreed`;
    return null;
  }

  /** Signature of the transaction that created the escrow (the oldest one touching it). */
  async function depositSignature(bookingId: string): Promise<string | undefined> {
    const sigs = await rpc('listing escrow transactions', () => connection.getSignaturesForAddress(pda(bookingId), { limit: 50 }, 'confirmed'));
    return sigs.filter((s) => !s.err).at(-1)?.signature;
  }

  /** Maps a settled on-chain escrow onto the record (e.g. the hirer refunded it themselves). */
  function settledFromChain(e: EscrowRecord, on: OnchainEscrow): EscrowRecord | null {
    if (on.status === 'released') return touch(e, { status: 'released', payer: on.hirer.toBase58(), resultHash: hex(on.resultHash), error: undefined });
    if (on.status === 'refunded' || on.status === 'cancelled') return touch(e, { status: 'refunded', payer: on.hirer.toBase58(), error: undefined });
    return null;
  }

  const destAta = (owner: PublicKey, tokenProgram: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);

  return {
    name: PROVIDER_NAME,
    currency: 'USDC',
    programId,
    operator: operator.publicKey,
    escrowAddress: pda,
    fetchOnchain,

    async create({ bookingId, amountUsd, payee, deadline }) {
      const { decimals } = await mintInfo();
      if (!(amountUsd > 0)) throw new Error(`escrow amount must be positive, got ${amountUsd}`);
      const payeeKey = payee ? new PublicKey(payee) : operator.publicKey; // throws on a bad address
      const t = now();
      const endpoint = `${config.PUBLIC_URL.replace(/\/$/, '')}/solana-pay/escrow/${encodeURIComponent(bookingId)}`;
      return {
        id: newId('esc'),
        bookingId,
        provider: PROVIDER_NAME,
        status: 'awaiting_deposit',
        amount: Number(fromBaseUnits(toBaseUnits(amountUsd, decimals), decimals)),
        currency: 'USDC',
        reference: pda(bookingId).toBase58(),
        payUrl: transactionRequestUrl(endpoint),
        payee: payeeKey.toBase58(),
        deadline: deadline ?? t + 14 * 86_400_000,
        txs: [],
        createdAt: t,
        updatedAt: t,
      };
    },

    async buildDepositTransaction(escrow, account) {
      if (escrow.status !== 'awaiting_deposit') throw new Error(`escrow is ${escrow.status}, not awaiting a deposit`);
      const hirer = new PublicKey(account);
      const { decimals, tokenProgram } = await mintInfo();
      const deadlineS = BigInt(Math.floor((escrow.deadline ?? now() + 14 * 86_400_000) / 1000));
      if (Number(deadlineS) * 1000 <= now()) throw new Error('the escrow deadline has passed; ask for a new booking');
      const ix = initializeAndDepositIx({
        programId,
        hirer,
        authority: operator.publicKey,
        payee: new PublicKey(escrow.payee ?? operator.publicKey),
        mint,
        bookingId: escrow.bookingId,
        amount: toBaseUnits(escrow.amount, decimals),
        deadline: deadlineS,
        tokenProgram,
      });
      const { blockhash, lastValidBlockHeight } = await rpc('fetching a blockhash', () => connection.getLatestBlockhash('confirmed'));
      const tx = new Transaction({ feePayer: hirer, blockhash, lastValidBlockHeight }).add(ix);
      const transaction = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
      const until = new Date(Number(deadlineS) * 1000).toISOString().slice(0, 16).replace('T', ' ');
      return { transaction, message: `Lock ${escrow.amount} ${escrow.currency} for HAAS booking ${escrow.bookingId}. Refundable to you after ${until} UTC if not released.` };
    },

    async refresh(escrow) {
      if (escrow.status !== 'awaiting_deposit' && escrow.status !== 'funded') return escrow;
      const on = await fetchOnchain(escrow.bookingId);
      if (!on) return escrow;
      const settled = settledFromChain(escrow, on);
      if (settled) return settled;
      if (escrow.status === 'funded') return escrow;
      const problem = await mismatch(escrow, on);
      const sig = await depositSignature(escrow.bookingId).catch(() => undefined);
      const base = { payer: on.hirer.toBase58(), ...(sig ? { depositTx: sig, ...withTx(escrow, 'deposit', sig) } : {}) };
      if (problem) return touch(escrow, { ...base, status: 'failed', error: `deposit rejected: ${problem}` });
      return touch(escrow, { ...base, status: 'funded', deadline: Number(on.deadline) * 1000, error: undefined });
    },

    async release(escrow, opts = {}) {
      if (escrow.status === 'released') return escrow;
      const on = await fetchOnchain(escrow.bookingId);
      if (!on) throw new Error(`escrow ${escrow.id} has no on-chain account; nothing to release`);
      const settled = settledFromChain(escrow, on);
      if (settled) {
        if (settled.status !== 'released') throw new Error(`escrow ${escrow.id} was already refunded on chain`);
        return settled;
      }
      const { tokenProgram } = await mintInfo();
      const resultHash = toResultHash(opts.resultHash);
      const dest = destAta(on.payee, tokenProgram);
      const sig = await send('releasing escrow', [
        createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, dest, on.payee, mint, tokenProgram),
        releaseIx({ programId, signer: operator.publicKey, escrow: pda(escrow.bookingId), hirer: on.hirer, mint, destination: dest, tokenProgram, resultHash }),
      ]);
      return touch(escrow, { status: 'released', settleTx: sig, resultHash: hex(resultHash), payer: on.hirer.toBase58(), error: undefined, ...withTx(escrow, 'release', sig) });
    },

    async refund(escrow) {
      if (escrow.status === 'refunded') return escrow;
      const on = await fetchOnchain(escrow.bookingId);
      // Never deposited: nothing is held.
      if (!on) return touch(escrow, { status: 'refunded', error: undefined });
      const settled = settledFromChain(escrow, on);
      if (settled) {
        if (settled.status === 'released') return touch(settled, { error: 'already released on chain; cannot refund' });
        return settled;
      }
      const { tokenProgram } = await mintInfo();
      const dest = destAta(on.hirer, tokenProgram);
      const args = { programId, signer: operator.publicKey, escrow: pda(escrow.bookingId), hirer: on.hirer, mint, destination: dest, tokenProgram };
      const createDest = createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, dest, on.hirer, mint, tokenProgram);
      // After the deadline use the permissionless refund (what anyone could do); before it, the arbiter's cancel.
      const timedOut = now() / 1000 >= Number(on.deadline) + SKEW_S;
      let kind: EscrowTx['kind'] = timedOut ? 'refund' : 'cancel';
      let sig: string;
      try {
        sig = await send(timedOut ? 'refunding escrow after its deadline' : 'cancelling escrow', [createDest, timedOut ? refundIx(args) : cancelIx(args)]);
      } catch (e) {
        if (!timedOut) throw e;
        kind = 'cancel';
        sig = await send('cancelling escrow', [createDest, cancelIx(args)]);
      }
      return touch(escrow, { status: 'refunded', settleTx: sig, payer: on.hirer.toBase58(), error: undefined, ...withTx(escrow, kind, sig) });
    },
  };
}
