// Registers the HAAS agent in the Masumi registry (POST /registry), waits for the mint, prints every value the
// TOKEN2049 submission and the .env need.
// Usage: pnpm register:agent [--dry-run]
//   needs MASUMI_API_KEY with Read+Pay, PUBLIC_URL as an HTTPS URL, a funded selling wallet with collateral.
//   --dry-run prints the request body and sends nothing.
// Pricing: V2 sources register {"pricingType":"Dynamic"} and nothing else (the TOKEN2049 guide); each payment request
// then carries the quote, 1 test USDM by default (MASUMI_PRICE_AMOUNT of MASUMI_PRICE_UNIT). V1 sources have no
// Dynamic pricing here and register that quote as a Fixed price.
// Optional: REGISTER_AUTHOR_NAME, REGISTER_AUTHOR_EMAIL, REGISTER_AUTHOR_ORGANIZATION, REGISTER_AUTHOR_CONTACT.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { loadConfig } from '../src/config';
import { formatAmount, normalizeUnit, quoteFee } from '../src/masumi/pricing';

const config = loadConfig();
const base = config.MASUMI_API_URL.replace(/\/+$/, '');
const dryRun = process.argv.includes('--dry-run');
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const quote = quoteFee(undefined, config);
const publicUrl = config.PUBLIC_URL.replace(/\/+$/, '');

const env = (k: string) => process.env[k]?.trim() || undefined;
const author = {
  name: env('REGISTER_AUTHOR_NAME') ?? 'HAAS team',
  ...(env('REGISTER_AUTHOR_EMAIL') ? { contactEmail: env('REGISTER_AUTHOR_EMAIL') } : {}),
  ...(env('REGISTER_AUTHOR_CONTACT') ? { contactOther: env('REGISTER_AUTHOR_CONTACT') } : {}),
  ...(env('REGISTER_AUTHOR_ORGANIZATION') ? { organization: env('REGISTER_AUTHOR_ORGANIZATION') } : {}),
};

const metadata = {
  name: 'HAAS: Human as a Service',
  description:
    'Hire a human freelancer for any task an AI cannot do. Send a brief; get a ranked shortlist from Freelancer.com, RentAHuman, Fiverr and more, ' +
    'with price, location, time zone and track record; confirm one and it is booked after your approval.',
  apiBaseUrl: publicUrl,
  Tags: ['human-in-the-loop', 'hire-human', 'freelancer', 'real-world-tasks', 'verification'],
  // MIP-003 /demo serves a sample input and output.
  ExampleOutputs: [{ name: 'Sample brief and booking result (MIP-003 /demo)', url: `${publicUrl}/demo`, mimeType: 'application/json' }],
  Capability: { name: 'haas', version },
  Author: author,
};

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { token: config.MASUMI_API_KEY ?? '', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

const sources = z.looseObject({
  data: z.looseObject({
    PaymentSources: z.array(z.looseObject({ id: z.string(), network: z.string(), paymentSourceType: z.string(), smartContractAddress: z.string() })),
  }),
});
const wallets = z.looseObject({ data: z.looseObject({ Wallets: z.array(z.looseObject({ walletVkey: z.string() })) }) });
const entry = z.looseObject({
  id: z.string(),
  state: z.string(),
  error: z.string().nullish(),
  agentIdentifier: z.string().nullish(),
  SmartContractWallet: z.looseObject({ walletVkey: z.string() }).nullish(),
});

async function main() {
  if (!config.MASUMI_API_KEY) throw new Error('MASUMI_API_KEY is not set (see infra/masumi/README.md step 4)');
  if (!/^https:\/\//.test(config.PUBLIC_URL)) {
    console.warn(`warning: PUBLIC_URL is ${config.PUBLIC_URL}; the registry needs a public HTTPS URL for the agent API`);
  }

  const src = sources
    .parse(await api('GET', '/payment-source?take=50'))
    .data.PaymentSources.filter((s) => s.network === config.MASUMI_NETWORK)
    .sort((a, b) => Number(b.paymentSourceType === 'Web3CardanoV2') - Number(a.paymentSourceType === 'Web3CardanoV2'))[0];
  if (!src) throw new Error(`no ${config.MASUMI_NETWORK} payment source found; was the service seeded?`);
  const v2 = src.paymentSourceType === 'Web3CardanoV2';
  console.log(`payment source ${src.id} (${src.paymentSourceType}) at ${src.smartContractAddress}`);

  let vkey = config.MASUMI_SELLER_VKEY;
  if (!vkey) {
    const q = new URLSearchParams({ walletType: 'Selling', paymentSourceId: src.id, take: '1' });
    vkey = wallets.parse(await api('GET', `/wallet/list?${q}`)).data.Wallets[0]?.walletVkey;
  }
  if (!vkey) throw new Error('no selling wallet found; set MASUMI_SELLER_VKEY');

  // V2 sources carry their own pricing; V1 uses AgentPricing. The API forbids the other one.
  // Dynamic: exactly {"pricingType":"Dynamic"}; extra keys get the registration rejected.
  const pricing = v2
    ? {
        supportedPaymentSources: [
          {
            chain: 'Cardano',
            network: config.MASUMI_NETWORK,
            paymentSourceType: 'Web3CardanoV2',
            address: src.smartContractAddress,
            pricing: { pricingType: 'Dynamic' },
          },
        ],
      }
    : { AgentPricing: { pricingType: 'Fixed', Pricing: [{ unit: normalizeUnit(quote.unit), amount: quote.amount }] } };

  const body = { network: config.MASUMI_NETWORK, sellingWalletVkey: vkey, ...metadata, ...pricing };
  if (dryRun) {
    console.log(JSON.stringify(body, null, 2));
    console.log(`\ndry run: nothing sent. Quote per job: ${formatAmount(quote)} (${quote.amount} of unit ${quote.unit || 'lovelace'})`);
    return;
  }
  const created = entry.parse((await api<{ data: unknown }>('POST', '/registry', body)).data);
  console.log(`registration requested: ${created.id} (${created.state}); waiting for the mint, this can take several minutes`);

  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 15_000));
    const q = new URLSearchParams({ network: config.MASUMI_NETWORK, filterPaymentSourceType: src.paymentSourceType, limit: '50' });
    const list = z.looseObject({ data: z.looseObject({ Assets: z.array(entry) }) }).parse(await api('GET', `/registry?${q}`));
    const mine = list.data.Assets.find((e) => e.id === created.id);
    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`  ${secs}s: ${mine?.state ?? 'not listed yet'}`);
    if (mine?.state === 'RegistrationFailed') throw new Error(`registration failed: ${mine.error ?? 'no reason given'}`);
    if (mine?.agentIdentifier) {
      const sellerVkey = mine.SmartContractWallet?.walletVkey ?? vkey;
      console.log(`\nRegistered: ${mine.state}\n`);
      console.log('Submission values:');
      console.log(`  Masumi agent identifier   ${mine.agentIdentifier}`);
      console.log(`  Registry entry id         ${created.id}`);
      console.log(`  Policy id                 ${mine.agentIdentifier.slice(0, 56)}`);
      console.log(`  Network                   ${config.MASUMI_NETWORK}`);
      console.log(`  Payment source            ${src.id} (${src.paymentSourceType}), supported source index 0`);
      console.log(`  Smart contract address    ${src.smartContractAddress}`);
      console.log(`  Seller wallet vkey        ${sellerVkey}`);
      console.log(`  Pricing                   ${v2 ? '{"pricingType":"Dynamic"}' : 'Fixed'}, quoted ${formatAmount(quote)} per job`);
      console.log(`  Asset unit                ${quote.unit || 'lovelace (ADA)'}`);
      console.log(`  Agent API (apiBaseUrl)    ${publicUrl}`);
      console.log(`  Tags                      ${metadata.Tags.join(', ')}`);
      console.log(`  Capability                ${metadata.Capability.name} ${metadata.Capability.version}`);
      console.log(`  Example output            ${metadata.ExampleOutputs[0]!.url}`);
      console.log(`  Author                    ${JSON.stringify(author)}`);
      console.log('  Seller address            admin UI > Wallets > Selling (not returned here)');
      console.log('\nPut these in ~/.haas/.env (or the Railway variables):\n');
      console.log(`PUBLIC_URL=${publicUrl}`);
      console.log(`MASUMI_API_URL=${config.MASUMI_API_URL}`);
      console.log('MASUMI_API_KEY=<the key you used>');
      console.log(`MASUMI_NETWORK=${config.MASUMI_NETWORK}`);
      console.log(`MASUMI_AGENT_IDENTIFIER=${mine.agentIdentifier}`);
      console.log(`MASUMI_SELLER_VKEY=${sellerVkey}`);
      console.log(`MASUMI_PRICING_TYPE=${v2 ? 'Dynamic' : 'Fixed'}`);
      if (v2) {
        console.log('MASUMI_SUPPORTED_PAYMENT_SOURCE_INDEX=0');
        console.log(`MASUMI_SMART_CONTRACT_ADDRESS=${src.smartContractAddress}`);
      }
      return;
    }
    if (secs > 30 * 60) throw new Error('timed out after 30 minutes; check the registry in the admin UI');
  }
}

main().catch((err) => {
  console.error(`register-agent: ${(err as Error).message}`);
  process.exit(1);
});
