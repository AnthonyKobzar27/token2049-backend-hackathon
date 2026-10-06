// Registers the HAAS agent in the Masumi registry (POST /registry), waits for the mint, prints .env values.
// Usage: pnpm register:agent   (needs MASUMI_API_KEY with Read+Pay, PUBLIC_URL as an HTTPS URL, funded selling wallet)
import { z } from 'zod';
import { loadConfig } from '../src/config';

const config = loadConfig();
const base = config.MASUMI_API_URL.replace(/\/+$/, '');
const priceLovelace = process.env.REGISTER_PRICE_LOVELACE ?? '3000000';

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
  const pricing = v2
    ? {
        supportedPaymentSources: [
          {
            chain: 'Cardano',
            network: config.MASUMI_NETWORK,
            paymentSourceType: 'Web3CardanoV2',
            address: src.smartContractAddress,
            pricing: { pricingType: 'Fixed', fixed: [{ asset: 'lovelace', amount: priceLovelace, decimals: 6 }] },
          },
        ],
      }
    : { AgentPricing: { pricingType: 'Fixed', Pricing: [{ unit: '', amount: priceLovelace }] } };

  const created = entry.parse(
    (
      await api<{ data: unknown }>('POST', '/registry', {
        network: config.MASUMI_NETWORK,
        sellingWalletVkey: vkey,
        name: 'HAAS: Human as a Service',
        description: 'Open router for freelancers: describe the work, get a ranked shortlist across platforms, confirm one, and it is booked.',
        apiBaseUrl: config.PUBLIC_URL,
        Tags: ['freelancers', 'hiring', 'marketplace', 'human-in-the-loop'],
        ExampleOutputs: [],
        Capability: { name: 'haas', version: '0.1.0' },
        Author: { name: 'HAAS' },
        ...pricing,
      })
    ).data,
  );
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
      console.log('\nPut these in ~/.haas/.env:\n');
      console.log(`PUBLIC_URL=${config.PUBLIC_URL}`);
      console.log(`MASUMI_API_URL=${config.MASUMI_API_URL}`);
      console.log('MASUMI_API_KEY=<the key you used>');
      console.log(`MASUMI_NETWORK=${config.MASUMI_NETWORK}`);
      console.log(`MASUMI_AGENT_IDENTIFIER=${mine.agentIdentifier}`);
      console.log(`MASUMI_SELLER_VKEY=${mine.SmartContractWallet?.walletVkey ?? vkey}`);
      return;
    }
    if (secs > 30 * 60) throw new Error('timed out after 30 minutes; check the registry in the admin UI');
  }
}

main().catch((err) => {
  console.error(`register-agent: ${(err as Error).message}`);
  process.exit(1);
});
