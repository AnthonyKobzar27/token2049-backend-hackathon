// A paying agent: calls POST /x402/route on the local HAAS server, shows the 402 challenge,
// pays in tADA on Cardano Preprod, prints the settlement tx and the job id.
// Needs: X402_CLIENT_MNEMONIC (funded preprod wallet), BLOCKFROST_PROJECT_ID, the HAAS server
// running with X402_PAY_TO set, and the facilitator from infra/x402-facilitator on port 4022.
// Run: pnpm spike:x402 ["task text"]

import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { toClientCardanoSigner } from '@x402/cardano';
import { ExactCardanoScheme } from '@x402/cardano/exact/client';
import { loadConfig } from '../src/config';

const config = loadConfig();
const base = process.env.HAAS_URL ?? `http://localhost:${config.PORT}`;
const task = process.argv[2] ?? 'Design a logo for a small coffee roaster';
const body = JSON.stringify({ task, skills: ['logo design'], budgetUsd: 100, remoteOk: true });
const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body };

if (!config.X402_CLIENT_MNEMONIC) throw new Error('Set X402_CLIENT_MNEMONIC (funded Cardano preprod wallet) in ~/.haas/.env');
if (!config.BLOCKFROST_PROJECT_ID) throw new Error('Set BLOCKFROST_PROJECT_ID (Blockfrost preprod project) in ~/.haas/.env');

console.log(`== 1. unpaid request: POST ${base}/x402/route`);
const challenge = await fetch(`${base}/x402/route`, init);
console.log(`HTTP ${challenge.status}`);
const header = challenge.headers.get('payment-required');
if (challenge.status !== 402 || !header) throw new Error(`expected a 402 with a PAYMENT-REQUIRED header, got ${challenge.status}: ${await challenge.text()}`);
const required = decodePaymentRequiredHeader(header);
for (const a of required.accepts) console.log(`  accepts ${a.scheme} ${a.network}: ${a.amount} ${a.asset} to ${a.payTo}`);

console.log('\n== 2. pay and retry (the response is released once the tx is in a block, typically 20 to 60 s)');
const signer = toClientCardanoSigner({
  mnemonic: config.X402_CLIENT_MNEMONIC,
  network: config.X402_NETWORK,
  provider: { blockfrost: { baseUrl: process.env.BLOCKFROST_BASE_URL ?? 'https://cardano-preprod.blockfrost.io/api/v0', projectId: config.BLOCKFROST_PROJECT_ID }, requestTimeoutMs: 30_000 },
});
console.log(`payer ${signer.getAddress()}`);
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: config.X402_NETWORK as `${string}:${string}`, client: new ExactCardanoScheme(signer) }],
  // lovelace is not USD-pegged, so the default spend controls would refuse it.
  spendControls: { allowedAssets: [{ network: config.X402_NETWORK as `${string}:${string}`, asset: 'lovelace', maxAmountPerPayment: String(config.X402_PRICE_LOVELACE) }] },
});
const t0 = Date.now();
const paid = await pay(`${base}/x402/route`, init);
console.log(`HTTP ${paid.status} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
const receipt = paid.headers.get('payment-response');
if (receipt) {
  const s = decodePaymentResponseHeader(receipt);
  console.log(`settlement: success=${s.success} tx=${s.transaction} ${s.extra ? JSON.stringify(s.extra) : ''}`);
  console.log(`  https://preprod.cardanoscan.io/transaction/${s.transaction}`);
}
const out = (await paid.json()) as { job_id?: string; status_url?: string; error?: string };
console.log(`job id ${out.job_id ?? '(none)'}\nstatus ${out.status_url ?? JSON.stringify(out)}`);
if (!out.status_url) process.exit(1);

console.log('\n== 3. job status (unpaid)');
console.log(JSON.stringify(await (await fetch(out.status_url)).json(), null, 2));
