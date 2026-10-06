// Proves the Solana escrow end to end on devnet with a throwaway 6-decimal mint
// (no faucet USDC needed). Keys are kept in ~/.haas/spike-solana.json.
// Run: pnpm spike:solana

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import bs58 from 'bs58';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo, transferChecked, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { HAAS_HOME, testConfig } from '../src/config';
import { createSolanaEscrow } from '../src/payments/solana';

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

async function main() {
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

  const escrow = createSolanaEscrow(
    testConfig({ SOLANA_RPC_URL: RPC, SOLANA_USDC_MINT: mint.toBase58(), SOLANA_OPERATOR_SECRET: bs58.encode(operator.secretKey), ESCROW_PROVIDER: 'solana' }),
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

  const pass = checks.every(([, ok]) => ok);
  console.log(`\n${pass ? 'PASS' : 'FAIL'} (${checks.filter(([, ok]) => ok).length}/${checks.length})`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(`\nFAIL: ${(e as Error).message}`);
  process.exit(1);
});
