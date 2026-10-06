import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { CARDANO_FACILITATORS, canonicalCardanoUnit, explorerUrl, MASUMI_USDM_PREPROD, normalizeNetwork, paymentKey, resolveAccepts } from './x402-networks';

const SOL_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const SOL_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

describe('x402 networks', () => {
  it('normalises network names to x402 ids', () => {
    expect(normalizeNetwork('cardano:preprod')).toBe('cardano:preprod');
    expect(normalizeNetwork('Solana:Devnet')).toBe(SOL_DEVNET);
    expect(normalizeNetwork('solana:mainnet')).toBe(SOL_MAINNET);
    expect(normalizeNetwork(SOL_DEVNET)).toBe(SOL_DEVNET);
    expect(() => normalizeNetwork('base-sepolia')).toThrow(/Unknown X402_NETWORK/);
  });

  it('builds explorer links per network', () => {
    expect(explorerUrl('cardano:preprod', 'ab')).toBe('https://preprod.cardanoscan.io/transaction/ab');
    expect(explorerUrl('cardano:mainnet', 'ab')).toBe('https://cardanoscan.io/transaction/ab');
    expect(explorerUrl(SOL_DEVNET, 'sig')).toBe('https://explorer.solana.com/tx/sig?cluster=devnet');
    expect(explorerUrl(SOL_MAINNET, 'sig')).toBe('https://explorer.solana.com/tx/sig');
    expect(explorerUrl('cardano:preprod', '')).toBeUndefined();
  });

  it('accepts a Cardano unit with or without the dot', () => {
    expect(canonicalCardanoUnit(MASUMI_USDM_PREPROD.replace('.', ''))).toBe(MASUMI_USDM_PREPROD);
    expect(canonicalCardanoUnit(MASUMI_USDM_PREPROD)).toBe(MASUMI_USDM_PREPROD);
    expect(() => canonicalCardanoUnit('usdm')).toThrow();
  });

  it('skips networks without a pay-to address', () => {
    const { accepts, skipped } = resolveAccepts(testConfig({ X402_PAY_TO: 'addr_test1x' }));
    expect(accepts.map((a) => a.network)).toEqual(['cardano:preprod']);
    expect(skipped).toEqual(['solana:devnet (X402_SOLANA_PAY_TO not set)']);
    expect(resolveAccepts(testConfig()).accepts).toEqual([]);
  });

  it('uses the hosted Cardano facilitator first, the self-hosted one as fallback', () => {
    const [a] = resolveAccepts(testConfig({ X402_PAY_TO: 'addr_test1x', X402_NETWORK: 'cardano:preprod' })).accepts;
    expect(a!.facilitators).toEqual([CARDANO_FACILITATORS['cardano:preprod'], 'http://localhost:4022']);
    const [m] = resolveAccepts(testConfig({ X402_PAY_TO: 'addr1x', X402_NETWORK: 'cardano:mainnet', X402_FACILITATOR_FALLBACK_URL: 'off' })).accepts;
    expect(m!.facilitators).toEqual([CARDANO_FACILITATORS['cardano:mainnet']]);
    expect(m!.asset).toBe('c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d');
  });

  it('prices the stablecoin from X402_PRICE_USD and honours a USDM unit override', () => {
    const cfg = testConfig({ X402_PAY_TO: 'addr_test1x', X402_SOLANA_PAY_TO: 'So1', X402_PRICE_USD: 1.25, X402_CARDANO_USDM_UNIT: 'e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c90014df10745553444d' });
    const [c, s] = resolveAccepts(cfg).accepts;
    expect(c).toMatchObject({ symbol: 'USDM', amount: '1250000', asset: 'e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9.0014df10745553444d' });
    expect(s).toMatchObject({ symbol: 'USDC', amount: '1250000', asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', facilitators: ['https://x402.org/facilitator'] });
  });

  it('X402_ASSET=USDC keeps only Solana', () => {
    const { accepts } = resolveAccepts(testConfig({ X402_PAY_TO: 'addr_test1x', X402_SOLANA_PAY_TO: 'So1', X402_ASSET: 'USDC' }));
    expect(accepts.map((a) => a.symbol)).toEqual(['USDC']);
  });

  it('keys a payment by a hash of the signed transaction when it is not a decodable Cardano tx', () => {
    const k = createHash('sha256').update('abc').digest('hex');
    expect(paymentKey(SOL_DEVNET, { transaction: 'abc' })).toBe(k);
    expect(paymentKey('cardano:preprod', { transaction: 'abc' })).toBe(k);
  });
});
