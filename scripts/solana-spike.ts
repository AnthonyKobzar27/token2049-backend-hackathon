// Proves the Solana escrow end to end on devnet with a throwaway 6-decimal mint
// (no faucet USDC needed). Keys are kept in ~/.haas/spike-solana.json.
// Run: pnpm spike:solana            on-chain haas-escrow program (needs it deployed, see programs/haas-escrow/README.md)
//      pnpm spike:solana --vault    server-held vault wallet
// Env: SOLANA_RPC_URL, SOLANA_ESCROW_PROGRAM_ID (default: the id in Anchor.toml).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import bs58 from 'bs58';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js';
import { createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo, transferChecked, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { HAAS_HOME, testConfig } from '../src/config';
import { createSolanaEscrow } from '../src/payments/solana';
import { createSolanaProgramEscrow } from '../src/payments/solana-program';
import { DEFAULT_ESCROW_PROGRAM_ID, hex, toResultHash } from '../src/payments/escrow-program';

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const FILE = join(HAAS_HOME, 'spike-solana.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const link = (sig?: string) => (sig ? `https://explorer.solana.com/tx/${sig}?cluster=devnet` : '(none)');
const step = (s: string) => console.log(`\n== ${s}`);

function loadKeys(): { operator: Keypair; payer: Keypair } {
  if (existsSync(FILE)) {
    const j = JSON.parse(readFileSync(FILE, 'utf8')) as { operator: string; payer: string };
    return { operator: Keypair.fromSecretKey(bs58.decode(j.operator)), payer: Keypair.fromSecretKey(bs58.decode(j.payer)) };
  }
  const k = { operator: Keypair.generate(), payer: Keypair.generate() };
  mkdirSync(HAAS_HOME, { recursive: true });
  writeFileSync(FILE, JSON.stringify({ operator: bs58.encode(k.operator.secretKey), payer: bs58.encode(k.payer.secretKey) }), { mode: 0o600 });
  return k;
}

async function ensureSol(c: Connection, who: string, key: PublicKey, min: number): Promise<void> {
  const have = await c.getBalance(key, 'confirmed');
  console.log(`${who} ${key.toBase58()}: ${have / LAMPORTS_PER_SOL} SOL`);
  if (have >= min * LAMPORTS_PER_SOL) return;
  for (let i = 0; i < 5; i++) {
    try {
      const sig = await c.requestAirdrop(key, 1 * LAMPORTS_PER_SOL);
      const bh = await c.getLatestBlockhash('confirmed');
      await c.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
      console.log(`  airdrop ok ${link(sig)}`);
      return;
    } catch (e) {
      console.log(`  airdrop attempt ${i + 1} failed: ${(e as Error).message.slice(0, 120)}`);
      await sleep(8000 * (i + 1));
    }
  }
  throw new Error(`devnet airdrop for ${who} failed after 5 spaced retries (faucet rate limit). Fund ${key.toBase58()} with devnet SOL (https://faucet.solana.com) and rerun.`);
}

const checks: [string, boolean][] = [];
const check = (name: string, ok: boolean) => (checks.push([name, ok]), console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`));

interface Env {
  c: Connection;
  operator: Keypair;
  payer: Keypair;
  mint: PublicKey;
  payerAta: PublicKey;
  bal: (owner: PublicKey) => Promise<bigint>;
}

async function setup(): Promise<Env> {
  const c = new Connection(RPC, 'confirmed');
  const { operator, payer } = loadKeys();
  step('wallets');
  await ensureSol(c, 'operator', operator.publicKey, 0.05);
  await ensureSol(c, 'payer   ', payer.publicKey, 0.02);

  step('throwaway 6-decimal mint, 100 test tokens to the payer');
  const mint = await createMint(c, operator, operator.publicKey, null, 6);
  console.log(`mint ${mint.toBase58()}`);
  const payerAta = (await getOrCreateAssociatedTokenAccount(c, operator, mint, payer.publicKey)).address;
  await mintTo(c, operator, mint, payerAta, operator, 100_000_000n);
  const bal = async (owner: PublicKey) => {
    try { return (await getAccount(c, getAssociatedTokenAddressSync(mint, owner, true), 'confirmed')).amount; } catch { return 0n; }
  };
  return { c, operator, payer, mint, payerAta, bal };
}

/** The on-chain program: hirer-signed deposit (Solana Pay transaction request), release, cancel, timeout refund. */
async function programSpike(): Promise<void> {
  const programId = new PublicKey(process.env.SOLANA_ESCROW_PROGRAM_ID ?? DEFAULT_ESCROW_PROGRAM_ID);
  const probe = await new Connection(RPC, 'confirmed').getAccountInfo(programId);
  if (!probe?.executable) throw new Error(`haas-escrow is not deployed at ${programId.toBase58()} on ${RPC}. Deploy it (programs/haas-escrow/README.md) or set SOLANA_ESCROW_PROGRAM_ID.`);
  console.log(`program ${programId.toBase58()} is deployed`);
  const { c, operator, payer, mint, bal } = await setup();
  const worker = Keypair.generate().publicKey;
  const escrow = createSolanaProgramEscrow(
    testConfig({ SOLANA_RPC_URL: RPC, SOLANA_USDC_MINT: mint.toBase58(), SOLANA_OPERATOR_SECRET: bs58.encode(operator.secretKey), SOLANA_ESCROW_PROGRAM_ID: programId.toBase58(), ESCROW_PROVIDER: 'solana-program' }),
    { connection: c },
  );
  /** What the hirer's wallet does with the Solana Pay transaction request: sign and send. */
  const payViaWallet = async (e: Awaited<ReturnType<typeof escrow.create>>) => {
    const { transaction, message } = await escrow.buildDepositTransaction(e, payer.publicKey.toBase58());
    console.log(`wallet prompt: "${message}"`);
    const tx = Transaction.from(Buffer.from(transaction, 'base64'));
    tx.partialSign(payer);
    const sig = await c.sendRawTransaction(tx.serialize());
    const bh = await c.getLatestBlockhash('confirmed');
    await c.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    console.log(`deposit ${link(sig)}`);
    return sig;
  };

  step('booking 1: lock 25.1 for the worker, then release with a result hash');
  const id1 = `spike_${Date.now()}_a`;
  let e1 = await escrow.create({ bookingId: id1, amountUsd: 25.1, payee: worker.toBase58(), deadline: Date.now() + 30 * 60_000 });
  console.log(`status ${e1.status}, escrow PDA ${e1.reference}\npayUrl ${e1.payUrl}`);
  check('create -> awaiting_deposit', e1.status === 'awaiting_deposit');
  check('refresh before deposit stays awaiting_deposit', (await escrow.refresh(e1)).status === 'awaiting_deposit');
  const dep1 = await payViaWallet(e1);
  e1 = await escrow.refresh(e1);
  console.log(`status ${e1.status}, payer ${e1.payer}, depositTx ${e1.depositTx}`);
  check('refresh -> funded', e1.status === 'funded');
  check('payer detected', e1.payer === payer.publicKey.toBase58());
  check('depositTx recorded', e1.depositTx === dep1);
  const resultHash = hex(toResultHash('spike delivery: logo.png sha256 placeholder'));
  e1 = await escrow.release(e1, { resultHash });
  console.log(`status ${e1.status}, ${link(e1.settleTx)}`);
  check('release -> released', e1.status === 'released' && !!e1.settleTx);
  check('worker balance 25.1', (await bal(worker)) === 25_100_000n);
  const on1 = await escrow.fetchOnchain(id1);
  check('on-chain status released with the result hash', on1?.status === 'released' && hex(on1.resultHash) === resultHash);

  step('booking 2: lock 10, operator cancels before the deadline');
  const id2 = `spike_${Date.now()}_b`;
  let e2 = await escrow.create({ bookingId: id2, amountUsd: 10, deadline: Date.now() + 30 * 60_000 });
  const before2 = await bal(payer.publicKey);
  await payViaWallet(e2);
  e2 = await escrow.refresh(e2);
  check('booking 2 funded', e2.status === 'funded');
  e2 = await escrow.refund(e2);
  console.log(`status ${e2.status}, ${e2.txs?.at(-1)?.kind} ${link(e2.settleTx)}`);
  check('cancel -> refunded', e2.status === 'refunded' && e2.txs?.at(-1)?.kind === 'cancel');
  check('payer balance restored', (await bal(payer.publicKey)) === before2);

  step('booking 3: lock 5 with a 45 s deadline, wait it out, permissionless refund');
  const id3 = `spike_${Date.now()}_c`;
  let e3 = await escrow.create({ bookingId: id3, amountUsd: 5, deadline: Date.now() + 45_000 });
  const before3 = await bal(payer.publicKey);
  await payViaWallet(e3);
  e3 = await escrow.refresh(e3);
  check('booking 3 funded', e3.status === 'funded');
  const wait = Math.max(0, (e3.deadline ?? 0) - Date.now()) + 40_000;
  console.log(`waiting ${Math.round(wait / 1000)} s for the deadline (plus clock skew margin)`);
  await sleep(wait);
  e3 = await escrow.refund(e3);
  console.log(`status ${e3.status}, ${e3.txs?.at(-1)?.kind} ${link(e3.settleTx)}`);
  check('timeout refund -> refunded', e3.status === 'refunded' && e3.txs?.at(-1)?.kind === 'refund');
  check('payer balance restored', (await bal(payer.publicKey)) === before3);
}

/** The server-held vault wallet (ESCROW_PROVIDER=solana-vault). */
async function vaultSpike(): Promise<void> {
  const { c, operator, payer, mint, payerAta, bal } = await setup();
  const escrow = createSolanaEscrow(
    testConfig({ SOLANA_RPC_URL: RPC, SOLANA_USDC_MINT: mint.toBase58(), SOLANA_OPERATOR_SECRET: bs58.encode(operator.secretKey), ESCROW_PROVIDER: 'solana-vault' }),
    { connection: c },
  );
  const deposit = async (to: string, units: bigint) => transferChecked(c, payer, payerAta, mint, getAssociatedTokenAddressSync(mint, new PublicKey(to), true), payer, units, 6);

  // ---- booking 1: deposit then release
  step('booking 1: create');
  const id1 = `spike_${Date.now()}_a`;
  let e1 = await escrow.create({ bookingId: id1, amountUsd: 25.1 });
  console.log(`status ${e1.status}, vault ${e1.address}\npayUrl ${e1.payUrl}`);
  check('create -> awaiting_deposit', e1.status === 'awaiting_deposit');
  check('refresh before deposit stays awaiting_deposit', (await escrow.refresh(e1)).status === 'awaiting_deposit');
  step('booking 1: payer deposits 25.1');
  const dep1 = await deposit(e1.address!, 25_100_000n);
  console.log(`deposit ${link(dep1)}`);
  e1 = await escrow.refresh(e1);
  console.log(`status ${e1.status}, payer ${e1.payer}, depositTx ${e1.depositTx}`);
  check('refresh -> funded', e1.status === 'funded');
  check('payer detected', e1.payer === payer.publicKey.toBase58());
  check('depositTx recorded', e1.depositTx === dep1);
  step('booking 1: release');
  const opBefore = await bal(operator.publicKey);
  e1 = await escrow.release(e1);
  console.log(`status ${e1.status}, ${link(e1.settleTx)}`);
  const opAfter = await bal(operator.publicKey);
  check('release -> released', e1.status === 'released' && !!e1.settleTx);
  check('operator balance +25.1', opAfter - opBefore === 25_100_000n);
  check('vault empty', (await bal(new PublicKey(e1.address!))) === 0n);

  // ---- booking 2: deposit then refund
  step('booking 2: create, deposit 10, refund');
  const id2 = `spike_${Date.now()}_b`;
  let e2 = await escrow.create({ bookingId: id2, amountUsd: 10 });
  const payerBefore = await bal(payer.publicKey);
  await deposit(e2.address!, 10_000_000n);
  e2 = await escrow.refresh(e2);
  check('booking 2 funded', e2.status === 'funded');
  check('payer balance dropped by 10', payerBefore - (await bal(payer.publicKey)) === 10_000_000n);
  e2 = await escrow.refund(e2);
  console.log(`status ${e2.status}, ${link(e2.settleTx)}`);
  check('refund -> refunded', e2.status === 'refunded' && !!e2.settleTx);
  check('payer balance restored', (await bal(payer.publicKey)) === payerBefore);
}

async function main() {
  await (process.argv.includes('--vault') ? vaultSpike() : programSpike());
  const pass = checks.every(([, ok]) => ok);
  console.log(`\n${pass ? 'PASS' : 'FAIL'} (${checks.filter(([, ok]) => ok).length}/${checks.length})`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nFAIL: ${(e as Error).message}`);
  process.exit(1);
});
