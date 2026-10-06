import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { testConfig } from '../config';
import { createEscrowProvider } from './index';
import { createMemoryEscrow } from './memory';
import { buildPayUrl, deriveReference, deriveVault, fromBaseUnits, toBaseUnits } from './solana';

describe('memory escrow', () => {
  it('is funded on create and settles by status', async () => {
    const p = createMemoryEscrow();
    const e = await p.create({ bookingId: 'bkg_1', amountUsd: 12.5 });
    expect(e).toMatchObject({ provider: 'memory', status: 'funded', amount: 12.5, currency: 'USDC', bookingId: 'bkg_1' });
    expect(e.id).toMatch(/^esc_/);
    expect(await p.refresh(e)).toBe(e);
    expect((await p.release(e)).status).toBe('released');
    expect((await p.refund(e)).status).toBe('refunded');
    expect(e.status).toBe('funded');
  });
});

describe('createEscrowProvider', () => {
  const store = {} as never;
  it('defaults to memory', () => {
    expect(createEscrowProvider({ store, config: testConfig() }).name).toBe('memory');
  });
  it('throws without an operator secret', () => {
    expect(() => createEscrowProvider({ store, config: testConfig({ ESCROW_PROVIDER: 'solana' }) })).toThrow(/SOLANA_OPERATOR_SECRET/);
  });
  it('builds the solana provider', () => {
    const secret = bs58.encode(Keypair.generate().secretKey);
    const p = createEscrowProvider({ store, config: testConfig({ ESCROW_PROVIDER: 'solana', SOLANA_OPERATOR_SECRET: secret }) });
    expect(p).toMatchObject({ name: 'solana', currency: 'USDC' });
  });
});

describe('derivation', () => {
  const secret = Keypair.generate().secretKey;
  it('is deterministic and differs per booking', () => {
    expect(deriveVault(secret, 'a').publicKey.equals(deriveVault(secret, 'a').publicKey)).toBe(true);
    expect(deriveVault(secret, 'a').publicKey.equals(deriveVault(secret, 'b').publicKey)).toBe(false);
    expect(deriveReference(secret, 'a').equals(deriveReference(secret, 'a'))).toBe(true);
    expect(deriveReference(secret, 'a').equals(deriveReference(secret, 'b'))).toBe(false);
  });
  it('separates vault, reference and operators', () => {
    expect(deriveReference(secret, 'a').equals(deriveVault(secret, 'a').publicKey)).toBe(false);
    expect(deriveVault(Keypair.generate().secretKey, 'a').publicKey.equals(deriveVault(secret, 'a').publicKey)).toBe(false);
  });
});

describe('amounts', () => {
  it('converts to base units exactly', () => {
    expect(toBaseUnits(25.1, 6)).toBe(25_100_000n);
    expect(toBaseUnits(0.1 + 0.2, 6)).toBe(300_000n);
    expect(toBaseUnits(1.005, 6)).toBe(1_005_000n);
    expect(toBaseUnits(100, 6)).toBe(100_000_000n);
    expect(toBaseUnits(0.000001, 6)).toBe(1n);
    expect(toBaseUnits(12.5, 0)).toBe(13n);
    expect(() => toBaseUnits(-1, 6)).toThrow();
    expect(() => toBaseUnits(NaN, 6)).toThrow();
  });
  it('formats base units', () => {
    expect(fromBaseUnits(25_100_000n, 6)).toBe('25.1');
    expect(fromBaseUnits(1n, 6)).toBe('0.000001');
    expect(fromBaseUnits(5_000_000n, 6)).toBe('5');
  });
});

describe('payUrl', () => {
  it('follows Solana Pay and encodes values', () => {
    const k = Keypair.generate().publicKey.toBase58();
    const url = buildPayUrl({ recipient: k, amount: '25.1', mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', reference: k, message: 'bkg 1&x' });
    expect(url.startsWith(`solana:${k}?amount=25.1&spl-token=4zMMC9`)).toBe(true);
    expect(url).toContain(`&reference=${k}&label=HAAS&message=bkg%201%26x`);
    const u = new URL(url.replace('solana:', 'solana://'));
    expect(u.searchParams.get('message')).toBe('bkg 1&x');
  });
});
