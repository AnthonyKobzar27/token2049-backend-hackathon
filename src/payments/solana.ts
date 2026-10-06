// Booking-budget escrow on Solana in USDC. One vault wallet per booking, derived from
// the operator key, so nothing secret is stored. Deposits go to the vault's token account;
// release pays the operator, refund pays the payer back.

import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
  type ParsedTransactionWithMeta,
} from '@solana/web3.js';
import {
  TokenAccountNotFoundError,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import type { Config } from '../config';
import { newId, now } from '../domain/ids';
import type { EscrowProvider } from '../domain/ports';
import type { EscrowRecord } from '../domain/types';

// ------------------------------------------------------------ pure helpers

const sha256 = (...parts: (Uint8Array | string)[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

/** Deterministic keypair from the operator key, a label and the booking id. */
export function deriveKeypair(operatorSecretKey: Uint8Array, label: string, bookingId: string): Keypair {
  return Keypair.fromSeed(sha256(operatorSecretKey, label, bookingId));
}
/** Wallet that holds the deposit for one booking. */
export const deriveVault = (secret: Uint8Array, bookingId: string): Keypair => deriveKeypair(secret, 'haas-vault', bookingId);
/** Public key that marks the deposit in a Solana Pay request (no private key is ever used). */
export const deriveReference = (secret: Uint8Array, bookingId: string): PublicKey => deriveKeypair(secret, 'haas-reference', bookingId).publicKey;

/** Decimal token amount to base units without float error: 25.1 at 6 decimals is 25100000n. */
export function toBaseUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`invalid amount ${amount}`);
  const [whole = '0', frac = ''] = amount.toFixed(decimals).split('.');
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

/** Base units back to a plain decimal string without trailing zeros. */
export function fromBaseUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** Solana Pay transfer request: solana:<recipient>?amount=&spl-token=&reference=&label=&message= */
export function buildPayUrl(p: { recipient: string; amount: string; mint: string; reference: string; label?: string; message?: string }): string {
  const q = [
    ['amount', p.amount],
    ['spl-token', p.mint],
    ['reference', p.reference],
    ['label', p.label ?? 'HAAS'],
    ...(p.message ? [['message', p.message]] : []),
  ] as const;
  return `solana:${p.recipient}?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

export function decodeOperatorSecret(secret: string): Keypair {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(secret);
  } catch {
    throw new Error('SOLANA_OPERATOR_SECRET is not valid base58');
  }
  if (bytes.length !== 64) throw new Error(`SOLANA_OPERATOR_SECRET must decode to a 64-byte secret key, got ${bytes.length} bytes`);
  return Keypair.fromSecretKey(bytes);
}

// ------------------------------------------------------------- RPC plumbing

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isRateLimit = (e: unknown) => /429|too many requests|rate limit/i.test(msg(e));
const isExpired = (e: unknown) => /block height exceeded|blockhash not found|has expired/i.test(msg(e));

/** Runs an RPC call, backing off on rate limits (the public devnet RPC does this often). */
async function rpc<T>(what: string, fn: () => Promise<T>, delays = [1000, 2000, 4000, 8000]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (isRateLimit(e) && i < delays.length) {
        await sleep(delays[i]!);
        continue;
      }
      throw new Error(`Solana RPC error while ${what}: ${isRateLimit(e) ? 'rate limited (429), retries exhausted' : msg(e)}`);
    }
  }
}

export interface SolanaEscrowOptions {
  connection?: Connection;
}

export function createSolanaEscrow(config: Config, opts: SolanaEscrowOptions = {}): EscrowProvider & { vaultFor(bookingId: string): PublicKey } {
  if (!config.SOLANA_OPERATOR_SECRET) throw new Error('SOLANA_OPERATOR_SECRET is not set');
  const operator = decodeOperatorSecret(config.SOLANA_OPERATOR_SECRET);
  const mint = new PublicKey(config.SOLANA_USDC_MINT);
  const connection = opts.connection ?? new Connection(config.SOLANA_RPC_URL, 'confirmed');
  const secret = operator.secretKey;
  const devnet = config.SOLANA_RPC_URL.includes('devnet');
  const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}${devnet ? '?cluster=devnet' : ''}`;

  let decimalsP: Promise<number> | undefined;
  const decimals = () => (decimalsP ??= rpc('reading the mint', async () => (await getMint(connection, mint, 'confirmed')).decimals).catch((e) => ((decimalsP = undefined), Promise.reject(e))));

  const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);

  async function balanceOf(account: PublicKey): Promise<bigint> {
    return rpc('reading a token balance', async () => {
      try {
        return (await getAccount(connection, account, 'confirmed')).amount;
      } catch (e) {
        if (e instanceof TokenAccountNotFoundError) return 0n;
        throw e;
      }
    });
  }

  /** Signs with the operator (fee payer) plus extra signers, sends, confirms; retries once on blockhash expiry. */
  async function send(what: string, ixs: TransactionInstruction[], extra: Keypair[] = []): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await rpc(what, async () => {
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
          const tx = new Transaction({ feePayer: operator.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
          tx.sign(operator, ...extra);
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

  /** Most recent incoming transfer to the vault token account: its signature and the sender's wallet. */
  async function findDeposit(vault: PublicKey, vaultAta: PublicKey): Promise<{ sig: string; payer?: string } | undefined> {
    const sigs = await rpc('listing deposits', () => connection.getSignaturesForAddress(vaultAta, { limit: 20 }, 'confirmed'));
    for (const s of sigs) {
      if (s.err) continue;
      const tx: ParsedTransactionWithMeta | null = await rpc('reading a deposit', () =>
        connection.getParsedTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
      );
      const pre = tx?.meta?.preTokenBalances ?? [];
      const post = tx?.meta?.postTokenBalances ?? [];
      if (!tx || !post.length) continue;
      // Net change per owner for our mint.
      const delta = new Map<string, bigint>();
      for (const b of post) if (b.mint === mint.toBase58() && b.owner) delta.set(b.owner, (delta.get(b.owner) ?? 0n) + BigInt(b.uiTokenAmount.amount));
      for (const b of pre) if (b.mint === mint.toBase58() && b.owner) delta.set(b.owner, (delta.get(b.owner) ?? 0n) - BigInt(b.uiTokenAmount.amount));
      if ((delta.get(vault.toBase58()) ?? 0n) <= 0n) continue;
      const sender = [...delta].find(([, d]) => d < 0n)?.[0];
      return { sig: s.signature, payer: sender };
    }
    return undefined;
  }

  const touch = (e: EscrowRecord, patch: Partial<EscrowRecord>): EscrowRecord => ({ ...e, ...patch, updatedAt: now() });

  async function settle(escrow: EscrowRecord, to: PublicKey, status: 'released' | 'refunded'): Promise<EscrowRecord> {
    const vault = deriveVault(secret, escrow.bookingId);
    const vaultAta = ata(vault.publicKey);
    const dec = await decimals();
    const balance = await balanceOf(vaultAta);
    const need = toBaseUnits(escrow.amount, dec);
    if (balance === 0n && status === 'refunded') return touch(escrow, { status: 'refunded' });
    if (status === 'released' ? balance < need : false) throw new Error(`escrow ${escrow.id} holds ${fromBaseUnits(balance, dec)} of ${escrow.amount} ${escrow.currency}; cannot ${status === 'released' ? 'release' : 'refund'}`);
    const dest = ata(to);
    const sig = await send(`${status === 'released' ? 'releasing' : 'refunding'} escrow`, [
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, dest, to, mint),
      createTransferCheckedInstruction(vaultAta, mint, dest, vault.publicKey, balance, dec),
    ], [vault]);
    return touch(escrow, { status, settleTx: sig, explorerUrl: explorer(sig), error: undefined });
  }

  return {
    name: 'solana',
    currency: 'USDC',
    vaultFor: (bookingId) => deriveVault(secret, bookingId).publicKey,

    async create({ bookingId, amountUsd }) {
      await decimals();
      const vault = deriveVault(secret, bookingId).publicKey;
      const reference = deriveReference(secret, bookingId).toBase58();
      await send('creating the deposit account', [createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, ata(vault), vault, mint)]);
      const t = now();
      return {
        id: newId('esc'),
        bookingId,
        provider: 'solana',
        status: 'awaiting_deposit',
        amount: amountUsd,
        currency: 'USDC',
        address: vault.toBase58(),
        reference,
        payUrl: buildPayUrl({ recipient: vault.toBase58(), amount: fromBaseUnits(toBaseUnits(amountUsd, await decimals()), await decimals()), mint: mint.toBase58(), reference, message: bookingId }),
        createdAt: t,
        updatedAt: t,
      };
    },

    async refresh(escrow) {
      if (escrow.status !== 'awaiting_deposit') return escrow;
      const vault = deriveVault(secret, escrow.bookingId).publicKey;
      const vaultAta = ata(vault);
      const balance = await balanceOf(vaultAta);
      if (balance < toBaseUnits(escrow.amount, await decimals())) return escrow;
      const dep = await findDeposit(vault, vaultAta);
      return touch(escrow, { status: 'funded', depositTx: dep?.sig, payer: dep?.payer, explorerUrl: dep ? explorer(dep.sig) : escrow.explorerUrl });
    },

    async release(escrow) {
      if (escrow.status === 'released') return escrow;
      return settle(escrow, operator.publicKey, 'released');
    },

    async refund(escrow) {
      if (escrow.status === 'refunded') return escrow;
      if (!escrow.payer) {
        const vaultAta = ata(deriveVault(secret, escrow.bookingId).publicKey);
        const balance = await balanceOf(vaultAta);
        if (balance === 0n) return touch(escrow, { status: 'refunded' });
        return touch(escrow, { status: 'failed', error: `cannot refund ${fromBaseUnits(balance, await decimals())} ${escrow.currency}: the payer's wallet is unknown (no incoming transfer recorded); refund manually from vault ${escrow.address}` });
      }
      return settle(escrow, new PublicKey(escrow.payer), 'refunded');
    },
  };
}
