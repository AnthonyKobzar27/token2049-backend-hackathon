// Which chains, assets and facilitators the x402 paywall offers. Pure config resolution, so the
// one-config switch (X402_NETWORK) is testable without a server.
//
// Each payable network becomes one entry in the 402's `accepts`; a client pays on whichever it
// supports. Prices default to the chain's stablecoin: USDM on Cardano, USDC on Solana.

import { createHash } from 'node:crypto';
import { decodeCardanoTransaction, USDM_MAINNET_ASSET } from '@x402/cardano';
import { getDefaultAsset as svmDefaultAsset, SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2 } from '@x402/svm';
import type { Config } from '../config';

export type Chain = 'cardano' | 'solana';
export type CaipNetwork = `${string}:${string}`;

/** Masumi's USDM on Cardano Preprod (the token the Masumi faucet and payment service use). */
export const MASUMI_USDM_PREPROD = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d';

export const CARDANO_FACILITATORS: Record<string, string> = {
  'cardano:preprod': 'https://x402.preprod.dev.ecosyseng.cf-deployments.org',
  'cardano:mainnet': 'https://x402.mainnet.dev.ecosyseng.cf-deployments.org',
};

const ALIASES: Record<string, CaipNetwork> = {
  'cardano:preprod': 'cardano:preprod',
  'cardano:mainnet': 'cardano:mainnet',
  'cardano:preview': 'cardano:preview',
  'solana:devnet': SOLANA_DEVNET_CAIP2 as CaipNetwork,
  'solana-devnet': SOLANA_DEVNET_CAIP2 as CaipNetwork,
  'solana:mainnet': SOLANA_MAINNET_CAIP2 as CaipNetwork,
  solana: SOLANA_MAINNET_CAIP2 as CaipNetwork,
  [SOLANA_DEVNET_CAIP2]: SOLANA_DEVNET_CAIP2 as CaipNetwork,
  [SOLANA_MAINNET_CAIP2]: SOLANA_MAINNET_CAIP2 as CaipNetwork,
};

export const chainOf = (network: string): Chain => (network.startsWith('solana') ? 'solana' : 'cardano');

/** Canonical x402 network id for a configured name; throws on unknown names. */
export function normalizeNetwork(name: string): CaipNetwork {
  const id = ALIASES[name.trim().toLowerCase()] ?? ALIASES[name.trim()];
  if (!id) throw new Error(`Unknown X402_NETWORK entry '${name}'. Use cardano:preprod, cardano:mainnet, solana:devnet or solana:mainnet.`);
  return id;
}

/** Short human name, e.g. "solana:devnet". */
export function networkLabel(network: string): string {
  if (network === SOLANA_DEVNET_CAIP2) return 'solana:devnet';
  if (network === SOLANA_MAINNET_CAIP2) return 'solana:mainnet';
  return network;
}

/** `policyId.assetNameHex`, the form @x402/cardano requires; accepts the dotless concatenation too. */
export function canonicalCardanoUnit(unit: string): string {
  const u = unit.trim().toLowerCase();
  if (u.includes('.') || u === 'lovelace') return u;
  if (!/^[0-9a-f]{56,}$/.test(u)) throw new Error(`Not a Cardano asset unit: ${unit}`);
  return `${u.slice(0, 56)}.${u.slice(56)}`;
}

export interface AcceptedPayment {
  chain: Chain;
  network: CaipNetwork;
  /** USDM | USDC | ADA */
  symbol: string;
  payTo: string;
  /** Atomic units. */
  amount: string;
  asset: string;
  decimals: number;
  extra: Record<string, unknown>;
  /** Facilitators that can settle this network, in order of preference. */
  facilitators: string[];
}

const atomic = (usd: number, decimals: number) => String(Math.round(usd * 10 ** decimals));

/** Resolves X402_* config into the payment options of the 402. Empty when nothing is payable. */
export function resolveAccepts(config: Config): { accepts: AcceptedPayment[]; skipped: string[] } {
  const accepts: AcceptedPayment[] = [];
  const skipped: string[] = [];
  const names = config.X402_NETWORK.split(',').map((s) => s.trim()).filter(Boolean);
  const wanted = config.X402_ASSET;
  for (const name of names) {
    const network = normalizeNetwork(name);
    const chain = chainOf(network);
    if (accepts.some((a) => a.network === network)) continue;
    if (chain === 'cardano') {
      if (!config.X402_PAY_TO) {
        skipped.push(`${name} (X402_PAY_TO not set)`);
        continue;
      }
      const hosted = config.X402_FACILITATOR_URL ?? CARDANO_FACILITATORS[network];
      const fallback = config.X402_FACILITATOR_FALLBACK_URL.trim();
      const facilitators = [hosted, fallback && fallback !== 'off' ? fallback : undefined].filter((u): u is string => !!u);
      // L1 confirmations 0: the 202 is released once the payment tx is in a block (about 20 s).
      const extra = { assetTransferMethod: 'default', areFeesSponsored: false, confirmationPolicy: { l1Confirmations: 0 } };
      if (wanted === 'ADA') {
        accepts.push({ chain, network, symbol: 'ADA', payTo: config.X402_PAY_TO, amount: String(config.X402_PRICE_LOVELACE), asset: 'lovelace', decimals: 6, extra, facilitators });
      } else {
        const unit = config.X402_CARDANO_USDM_UNIT ?? (network === 'cardano:mainnet' ? USDM_MAINNET_ASSET : network === 'cardano:preprod' ? MASUMI_USDM_PREPROD : undefined);
        if (!unit) {
          skipped.push(`${name} (no USDM on this network; set X402_CARDANO_USDM_UNIT or X402_ASSET=ADA)`);
          continue;
        }
        accepts.push({ chain, network, symbol: 'USDM', payTo: config.X402_PAY_TO, amount: atomic(config.X402_PRICE_USD, 6), asset: canonicalCardanoUnit(unit), decimals: 6, extra, facilitators });
      }
    } else {
      if (!config.X402_SOLANA_PAY_TO) {
        skipped.push(`${name} (X402_SOLANA_PAY_TO not set)`);
        continue;
      }
      const usdc = svmDefaultAsset(network, 'USDC');
      accepts.push({
        chain,
        network,
        symbol: 'USDC',
        payTo: config.X402_SOLANA_PAY_TO,
        amount: atomic(config.X402_PRICE_USD, usdc.decimals),
        asset: usdc.asset,
        decimals: usdc.decimals,
        // Saves the client an RPC round trip to look up the mint's token program.
        extra: usdc.tokenProgram ? { tokenProgram: String(usdc.tokenProgram) } : {},
        facilitators: [config.X402_SOLANA_FACILITATOR_URL],
      });
    }
  }
  // An explicit asset narrows the offer to the chains that have it.
  const filtered = wanted === 'AUTO' ? accepts : accepts.filter((a) => a.symbol === wanted);
  for (const a of accepts) if (!filtered.includes(a)) skipped.push(`${networkLabel(a.network)} (X402_ASSET=${wanted} not on this chain)`);
  return { accepts: filtered, skipped };
}

/** Block explorer link for a settlement transaction. */
export function explorerUrl(network: string, tx: string): string | undefined {
  if (!tx) return undefined;
  switch (network) {
    case 'cardano:preprod':
      return `https://preprod.cardanoscan.io/transaction/${tx}`;
    case 'cardano:preview':
      return `https://preview.cardanoscan.io/transaction/${tx}`;
    case 'cardano:mainnet':
      return `https://cardanoscan.io/transaction/${tx}`;
    case SOLANA_DEVNET_CAIP2:
      return `https://explorer.solana.com/tx/${tx}?cluster=devnet`;
    case SOLANA_MAINNET_CAIP2:
      return `https://explorer.solana.com/tx/${tx}`;
    default:
      return undefined;
  }
}

/**
 * Stable key for one payment, known before settlement: the Cardano tx hash (the client signs the
 * whole tx), or for Solana, where the facilitator co-signs as fee payer and the signature only
 * exists after settlement, a hash of the client-signed transaction.
 */
export function paymentKey(network: string, payload: Record<string, unknown>): string {
  const tx = typeof payload.transaction === 'string' ? payload.transaction : JSON.stringify(payload);
  if (chainOf(network) === 'cardano') {
    try {
      return decodeCardanoTransaction(tx).txHash.toLowerCase();
    } catch {
      // fall through: undecodable payloads are rejected by the facilitator anyway
    }
  }
  return createHash('sha256').update(tx).digest('hex');
}
