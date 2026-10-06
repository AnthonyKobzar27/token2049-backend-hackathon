import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import { Keypair, PublicKey, Transaction, type AccountInfo } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { testConfig } from '../config';
import type { EscrowRecord } from '../domain/types';
import {
  ESCROW_ACCOUNT_DISCRIMINATOR,
  ESCROW_ACCOUNT_SIZE,
  IX,
  bookingHash,
  decodeEscrow,
  encodeEscrow,
  escrowPda,
  toResultHash,
  type OnchainEscrow,
} from './escrow-program';
import { createSolanaProgramEscrow, explorerTx, type EscrowConnection } from './solana-program';

const idl = JSON.parse(readFileSync(new URL('../../programs/haas-escrow/idl/haas_escrow.json', import.meta.url), 'utf8'));
const disc = (name: string) => Buffer.from(idl.instructions.find((i: { name: string }) => i.name === name).discriminator);

const operator = Keypair.generate();
const hirer = Keypair.generate().publicKey;
const worker = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const programId = new PublicKey(idl.address);
const T0 = 1_800_000_000_000; // epoch ms
const BOOKING = 'bk_test1';
const [pda, bump] = escrowPda(programId, operator.publicKey, BOOKING);

function mintAccount(decimals = 6): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  return { data, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false, rentEpoch: 0 };
}

function onchain(patch: Partial<OnchainEscrow> = {}): OnchainEscrow {
  return {
    authority: operator.publicKey, hirer, payee: worker, mint, bookingHash: bookingHash(BOOKING),
    amount: 25_500_000n, deadline: BigInt(T0 / 1000 + 3600), createdAt: BigInt(T0 / 1000),
    expectedResultHash: new Uint8Array(32), resultHash: new Uint8Array(32), status: 'funded', bump, ...patch,
  };
}

function harness(state: { escrow?: OnchainEscrow | null; failSend?: (n: number) => boolean } = {}) {
  const sent: Transaction[] = [];
  let clock = T0;
  const connection = {
    getAccountInfo: vi.fn(async (key: PublicKey) => {
      if (key.equals(mint)) return mintAccount();
      if (key.equals(pda) && state.escrow) return { data: encodeEscrow(state.escrow), owner: programId, lamports: 1, executable: false, rentEpoch: 0 };
      return null;
    }),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: 100 })),
    sendRawTransaction: vi.fn(async (raw: Buffer | Uint8Array | number[]) => {
      if (state.failSend?.(sent.length)) {
        sent.push(Transaction.from(Buffer.from(raw as Uint8Array)));
        throw new Error('custom program error: 0x1775');
      }
      sent.push(Transaction.from(Buffer.from(raw as Uint8Array)));
      return `sig${sent.length}`;
    }),
    confirmTransaction: vi.fn(async () => ({ context: { slot: 1 }, value: { err: null } })),
    getSignaturesForAddress: vi.fn(async () => [{ signature: 'later', err: null }, { signature: 'depositSig', err: null }]),
  } as unknown as EscrowConnection;
  const config = testConfig({
    ESCROW_PROVIDER: 'solana-program',
    SOLANA_OPERATOR_SECRET: bs58.encode(operator.secretKey),
    SOLANA_USDC_MINT: mint.toBase58(),
    SOLANA_ESCROW_PROGRAM_ID: programId.toBase58(),
    PUBLIC_URL: 'https://haas.example/',
  });
  const p = createSolanaProgramEscrow(config, { connection, now: () => clock });
  return { p, sent, connection, state, setClock: (t: number) => (clock = t) };
}

const programIxs = (tx: Transaction) => tx.instructions.filter((ix) => ix.programId.equals(programId));

async function created(h: ReturnType<typeof harness>, patch: Partial<EscrowRecord> = {}): Promise<EscrowRecord> {
  const rec = await h.p.create({ bookingId: BOOKING, amountUsd: 25.5, payee: worker.toBase58(), deadline: T0 + 3600_000 });
  return { ...rec, ...patch };
}

describe('escrow-program codec matches the IDL', () => {
  it('instruction and account discriminators', () => {
    expect(IX.initializeAndDeposit.equals(disc('initialize_and_deposit'))).toBe(true);
    expect(IX.release.equals(disc('release'))).toBe(true);
    expect(IX.refund.equals(disc('refund'))).toBe(true);
    expect(IX.cancel.equals(disc('cancel'))).toBe(true);
    expect(ESCROW_ACCOUNT_DISCRIMINATOR.equals(Buffer.from(idl.accounts[0].discriminator))).toBe(true);
  });

  it('account layout follows the IDL field order and round-trips', () => {
    const fields = idl.types.find((t: { name: string }) => t.name === 'Escrow').type.fields.map((f: { name: string }) => f.name);
    expect(fields).toEqual(['authority', 'hirer', 'payee', 'mint', 'booking_hash', 'amount', 'deadline', 'created_at', 'expected_result_hash', 'result_hash', 'status', 'bump']);
    expect(ESCROW_ACCOUNT_SIZE).toBe(8 + 32 * 4 + 32 + 8 * 3 + 32 + 32 + 1 + 1);
    const e = onchain({ status: 'released', resultHash: toResultHash('ab'.repeat(32)) });
    const d = decodeEscrow(encodeEscrow(e));
    expect(d.status).toBe('released');
    expect(d.amount).toBe(25_500_000n);
    expect(d.payee.equals(worker)).toBe(true);
    expect(Buffer.from(d.resultHash).toString('hex')).toBe('ab'.repeat(32));
    expect(() => decodeEscrow(Buffer.alloc(ESCROW_ACCOUNT_SIZE))).toThrow(/not a haas-escrow/);
  });

  it('result hashes: hex is used as is, other text is sha256-hashed, empty is zero', () => {
    expect(Buffer.from(toResultHash('CD'.repeat(32))).toString('hex')).toBe('cd'.repeat(32));
    expect(toResultHash('delivery text').length).toBe(32);
    expect(toResultHash(undefined).every((b) => b === 0)).toBe(true);
  });
});

describe('solana-program escrow', () => {
  it('create: transaction-request pay URL, PDA reference, payee and deadline; nothing on chain yet', async () => {
    const h = harness();
    const rec = await created(h);
    expect(rec).toMatchObject({ provider: 'solana-program', status: 'awaiting_deposit', amount: 25.5, currency: 'USDC', reference: pda.toBase58(), payee: worker.toBase58(), deadline: T0 + 3600_000, txs: [] });
    expect(rec.payUrl).toBe(`solana:${encodeURIComponent('https://haas.example/solana-pay/escrow/bk_test1')}`);
    expect(h.sent).toHaveLength(0);
    const toOperator = await h.p.create({ bookingId: 'bk2', amountUsd: 1 });
    expect(toOperator.payee).toBe(operator.publicKey.toBase58());
    await expect(h.p.create({ bookingId: 'bk3', amountUsd: 1, payee: 'nope' })).rejects.toThrow();
  });

  it('buildDepositTransaction: hirer pays the fee and signs one initialize_and_deposit call laid out per the IDL', async () => {
    const h = harness();
    const rec = await created(h);
    const { transaction, message } = await h.p.buildDepositTransaction(rec, hirer.toBase58());
    expect(message).toContain('25.5 USDC');
    const tx = Transaction.from(Buffer.from(transaction, 'base64'));
    expect(tx.feePayer?.equals(hirer)).toBe(true);
    const [ix] = programIxs(tx);
    const names = idl.instructions.find((i: { name: string }) => i.name === 'initialize_and_deposit').accounts.map((a: { name: string }) => a.name);
    expect(ix!.keys).toHaveLength(names.length);
    const at = (n: string) => ix!.keys[names.indexOf(n)]!;
    expect(at('hirer')).toMatchObject({ isSigner: true, isWritable: true });
    expect(at('hirer').pubkey.equals(hirer)).toBe(true);
    expect(at('authority').pubkey.equals(operator.publicKey)).toBe(true);
    expect(at('payee').pubkey.equals(worker)).toBe(true);
    expect(at('escrow').pubkey.equals(pda)).toBe(true);
    expect(at('vault').pubkey.equals(getAssociatedTokenAddressSync(mint, pda, true))).toBe(true);
    expect(at('hirer_token').pubkey.equals(getAssociatedTokenAddressSync(mint, hirer, true))).toBe(true);
    expect(at('associated_token_program').pubkey.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    const data = ix!.data;
    expect(data.subarray(0, 8).equals(IX.initializeAndDeposit)).toBe(true);
    expect(data.subarray(8, 40).equals(bookingHash(BOOKING))).toBe(true);
    expect(data.readBigUInt64LE(40)).toBe(25_500_000n);
    expect(data.readBigInt64LE(48)).toBe(BigInt((T0 + 3600_000) / 1000));
    expect(data.length).toBe(8 + 32 + 8 + 8 + 32);
  });

  it('buildDepositTransaction refuses once the deadline passed or the escrow is no longer open', async () => {
    const h = harness();
    const rec = await created(h);
    h.setClock(T0 + 3600_000);
    await expect(h.p.buildDepositTransaction(rec, hirer.toBase58())).rejects.toThrow(/deadline/);
    await expect(h.p.buildDepositTransaction({ ...rec, status: 'funded' }, hirer.toBase58())).rejects.toThrow(/funded/);
  });

  it('refresh: no account keeps waiting; a matching deposit is funded with its signature and devnet explorer link', async () => {
    const h = harness();
    const rec = await created(h);
    expect((await h.p.refresh(rec)).status).toBe('awaiting_deposit');
    h.state.escrow = onchain();
    const funded = await h.p.refresh(rec);
    expect(funded).toMatchObject({ status: 'funded', payer: hirer.toBase58(), depositTx: 'depositSig', deadline: T0 + 3600_000 });
    expect(funded.explorerUrl).toBe('https://explorer.solana.com/tx/depositSig?cluster=devnet');
    expect(funded.txs).toEqual([{ kind: 'deposit', signature: 'depositSig', url: 'https://explorer.solana.com/tx/depositSig?cluster=devnet', at: T0 }]);
  });

  it('refresh rejects a short deposit, a different payee or an earlier deadline', async () => {
    const h = harness();
    const rec = await created(h);
    h.state.escrow = onchain({ amount: 1_000_000n });
    expect(await h.p.refresh(rec)).toMatchObject({ status: 'failed', error: expect.stringContaining('expected 25.5') });
    h.state.escrow = onchain({ payee: hirer });
    expect(await h.p.refresh(rec)).toMatchObject({ status: 'failed', error: expect.stringContaining('escrow pays') });
    h.state.escrow = onchain({ deadline: BigInt(T0 / 1000 + 60) });
    expect(await h.p.refresh(rec)).toMatchObject({ status: 'failed', error: expect.stringContaining('deadline') });
  });

  it('refresh maps a refund the hirer triggered themselves', async () => {
    const h = harness({ escrow: onchain({ status: 'refunded' }) });
    const rec = await created(h, { status: 'funded' });
    expect((await h.p.refresh(rec)).status).toBe('refunded');
  });

  it('release: operator signs release(result_hash) to the payee ATA and records the tx', async () => {
    const h = harness({ escrow: onchain() });
    const rec = await created(h, { status: 'funded' });
    const out = await h.p.release(rec, { resultHash: 'ef'.repeat(32) });
    expect(out).toMatchObject({ status: 'released', settleTx: 'sig1', resultHash: 'ef'.repeat(32), explorerUrl: explorerTx('sig1', 'https://api.devnet.solana.com') });
    expect(out.txs?.at(-1)).toMatchObject({ kind: 'release', signature: 'sig1' });
    const tx = h.sent[0]!;
    expect(tx.feePayer?.equals(operator.publicKey)).toBe(true);
    expect(tx.verifySignatures()).toBe(true);
    const [ix] = programIxs(tx);
    expect(ix!.data.subarray(0, 8).equals(IX.release)).toBe(true);
    expect(ix!.data.subarray(8).toString('hex')).toBe('ef'.repeat(32));
    expect(ix!.keys[0]).toMatchObject({ isSigner: true });
    expect(ix!.keys[0]!.pubkey.equals(operator.publicKey)).toBe(true);
    expect(ix!.keys[5]!.pubkey.equals(getAssociatedTokenAddressSync(mint, worker, true))).toBe(true);
    // The payee ATA is created idempotently in the same transaction.
    expect(tx.instructions[0]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('release refuses when the chain says it was refunded, and is a no-op when already released', async () => {
    const h = harness({ escrow: onchain({ status: 'cancelled' }) });
    const rec = await created(h, { status: 'funded' });
    await expect(h.p.release(rec)).rejects.toThrow(/refunded on chain/);
    h.state.escrow = onchain({ status: 'released' });
    expect((await h.p.release(rec)).status).toBe('released');
    expect(h.sent).toHaveLength(0);
  });

  it('refund before the deadline uses cancel; after it, the permissionless refund', async () => {
    const before = harness({ escrow: onchain() });
    const r1 = await before.p.refund(await created(before, { status: 'funded' }));
    expect(r1).toMatchObject({ status: 'refunded', settleTx: 'sig1' });
    expect(r1.txs?.at(-1)?.kind).toBe('cancel');
    expect(programIxs(before.sent[0]!)[0]!.data.equals(IX.cancel)).toBe(true);
    expect(programIxs(before.sent[0]!)[0]!.keys[5]!.pubkey.equals(getAssociatedTokenAddressSync(mint, hirer, true))).toBe(true);

    const after = harness({ escrow: onchain() });
    after.setClock(T0 + 3600_000 + 60_000);
    const r2 = await after.p.refund(await created(after, { status: 'funded' }));
    expect(r2.txs?.at(-1)?.kind).toBe('refund');
    expect(programIxs(after.sent[0]!)[0]!.data.equals(IX.refund)).toBe(true);
  });

  it('refund after the deadline falls back to cancel when refund fails (validator clock behind)', async () => {
    const h = harness({ escrow: onchain(), failSend: (n) => n === 0 });
    h.setClock(T0 + 3600_000 + 60_000);
    const out = await h.p.refund(await created(h, { status: 'funded' }));
    expect(out.txs?.at(-1)?.kind).toBe('cancel');
    expect(programIxs(h.sent[1]!)[0]!.data.equals(IX.cancel)).toBe(true);
  });

  it('refund with nothing on chain settles without a transaction', async () => {
    const h = harness();
    expect((await h.p.refund(await created(h))).status).toBe('refunded');
    expect(h.sent).toHaveLength(0);
  });
});
