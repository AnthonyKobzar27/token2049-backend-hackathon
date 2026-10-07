// Creates a devnet "test USD" token (6 decimals) owned by the HAAS operator wallet and mints a float to it,
// so HAAS can fund booking escrows itself (ESCROW_AUTO_FUND=true) without a faucet.
// Usage: pnpm tsx scripts/create-test-usd.ts [amount]   then set SOLANA_USDC_MINT to the printed mint.
// With SOLANA_USDC_MINT already set to a mint the operator controls, it only tops the float up.
import { Connection, PublicKey } from '@solana/web3.js';
import { createMint, getMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { loadConfig } from '../src/config';
import { decodeOperatorSecret } from '../src/payments/solana';

const config = loadConfig();
if (!config.SOLANA_RPC_URL.includes('devnet')) throw new Error('refusing to mint outside devnet');
if (!config.SOLANA_OPERATOR_SECRET) throw new Error('SOLANA_OPERATOR_SECRET is not set');
const operator = decodeOperatorSecret(config.SOLANA_OPERATOR_SECRET);
const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
const amount = Number(process.argv[2] ?? 1_000_000);

let mint = new PublicKey(config.SOLANA_USDC_MINT);
const current = await getMint(connection, mint).catch(() => null);
if (!current?.mintAuthority?.equals(operator.publicKey)) {
  mint = await createMint(connection, operator, operator.publicKey, null, 6);
  console.log(`created test USD mint ${mint.toBase58()}`);
}
const ata = await getOrCreateAssociatedTokenAccount(connection, operator, mint, operator.publicKey);
const sig = await mintTo(connection, operator, mint, ata.address, operator, BigInt(Math.round(amount * 1e6)));
console.log(`minted ${amount} to ${operator.publicKey.toBase58()}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
console.log(`SOLANA_USDC_MINT=${mint.toBase58()}`);
