// A paying agent: calls POST /x402/route on the local HAAS server, shows the 402 challenge (every
// chain it offers), pays on the chosen chain with @x402/fetch, prints the settlement tx with its
// explorer link and the job id, then reads the job status.
//
// Run: pnpm spike:x402 cardano ["task text"]   pays USDM (or tADA) on Cardano Preprod
//      pnpm spike:x402 solana  ["task text"]   pays USDC on Solana devnet
//
// Needs the HAAS server running with the chain enabled (docs/X402.md) and, in ~/.haas/.env:
//   cardano: X402_CLIENT_MNEMONIC (preprod wallet holding the USDM or tADA), BLOCKFROST_PROJECT_ID
//   solana:  X402_SOLANA_CLIENT_SECRET (base58 devnet key holding devnet USDC; needs no SOL,
//            the facilitator pays the fee), SOLANA_RPC_URL (defaults to the public devnet RPC)

import bs58 from 'bs58';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { SchemeNetworkClient } from '@x402/core/types';
import { toClientCardanoSigner } from '@x402/cardano';
import { ExactCardanoScheme } from '@x402/cardano/exact/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { loadConfig } from '../src/config';
import { chainOf, explorerUrl, networkLabel, type CaipNetwork } from '../src/payments/x402-networks';

const config = loadConfig();
const chain = process.argv[2] === 'solana' ? 'solana' : process.argv[2] === 'cardano' ? 'cardano' : undefined;
if (!chain) throw new Error('Usage: pnpm spike:x402 <cardano|solana> ["task text"]');
const base = process.env.HAAS_URL ?? `http://localhost:${config.PORT}`;
const task = process.argv[3] ?? 'Design a logo for a small coffee roaster';
// Only the task text: HAAS reads skills, budget, time, place and language from it.
const body = JSON.stringify({ task });
const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body };

console.log(`== 1. unpaid request: POST ${base}/x402/route`);
const challenge = await fetch(`${base}/x402/route`, init);
console.log(`HTTP ${challenge.status}`);
const header = challenge.headers.get('payment-required');
if (challenge.status !== 402 || !header) throw new Error(`expected a 402 with a PAYMENT-REQUIRED header, got ${challenge.status}: ${await challenge.text()}`);
const required = decodePaymentRequiredHeader(header);
for (const a of required.accepts) console.log(`  accepts ${a.scheme} ${networkLabel(a.network)}: ${a.amount} ${a.asset} to ${a.payTo}`);
const offer = required.accepts.find((a) => chainOf(a.network) === chain);
if (!offer) throw new Error(`The server does not offer ${chain}; check X402_NETWORK and the pay-to address on the server.`);
const network = offer.network as CaipNetwork;

let client: SchemeNetworkClient;
if (chain === 'cardano') {
  if (!config.X402_CLIENT_MNEMONIC) throw new Error('Set X402_CLIENT_MNEMONIC (funded Cardano preprod wallet) in ~/.haas/.env');
  if (!config.BLOCKFROST_PROJECT_ID) throw new Error('Set BLOCKFROST_PROJECT_ID (Blockfrost preprod project) in ~/.haas/.env');
  const signer = toClientCardanoSigner({
    mnemonic: config.X402_CLIENT_MNEMONIC,
    network,
    provider: { blockfrost: { baseUrl: process.env.BLOCKFROST_BASE_URL ?? 'https://cardano-preprod.blockfrost.io/api/v0', projectId: config.BLOCKFROST_PROJECT_ID }, requestTimeoutMs: 30_000 },
  });
  console.log(`payer ${signer.getAddress()}`);
  client = new ExactCardanoScheme(signer);
} else {
  if (!config.X402_SOLANA_CLIENT_SECRET) throw new Error('Set X402_SOLANA_CLIENT_SECRET (base58 devnet key holding devnet USDC) in ~/.haas/.env');
  const signer = await createKeyPairSignerFromBytes(bs58.decode(config.X402_SOLANA_CLIENT_SECRET));
  console.log(`payer ${signer.address}`);
  client = new ExactSvmScheme(signer, { rpcUrl: config.SOLANA_RPC_URL });
}

console.log(`\n== 2. pay on ${networkLabel(network)} and retry (the response is released once the payment settles)`);
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network, client }],
  // Masumi's USDM and tADA are not in the SDK's USD-pegged table, so allow exactly the offered asset and amount.
  spendControls: { allowedAssets: [{ network, asset: offer.asset, maxAmountPerPayment: offer.amount }] },
});
const t0 = Date.now();
const paid = await pay(`${base}/x402/route`, init);
console.log(`HTTP ${paid.status} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const receipt = paid.headers.get('payment-response');
if (receipt) {
  const s = decodePaymentResponseHeader(receipt);
  console.log(`settlement: success=${s.success} tx=${s.transaction} ${s.extra ? JSON.stringify(s.extra) : ''}`);
  console.log(`  ${explorerUrl(s.network, s.transaction) ?? '(no explorer for this network)'}`);
}
const out = (await paid.json()) as { job_id?: string; status_url?: string; error?: string };
console.log(`job id ${out.job_id ?? '(none)'}\nstatus ${out.status_url ?? JSON.stringify(out)}`);
if (!out.status_url) process.exit(1);

console.log('\n== 3. job status (unpaid; carries the settlement tx and explorer link)');
console.log(JSON.stringify(await (await fetch(out.status_url)).json(), null, 2));
