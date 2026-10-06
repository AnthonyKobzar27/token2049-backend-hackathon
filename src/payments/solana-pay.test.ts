import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { Keypair } from '@solana/web3.js';
import { createStore } from '../db/db';
import type { EscrowProvider } from '../domain/ports';
import type { Booking, EscrowRecord } from '../domain/types';
import { mountSolanaPay } from './solana-pay';

const servers: { close(): void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function serve(o: { booking?: Partial<Booking>; escrow?: Partial<EscrowRecord>; window?: number; now?: number } = {}) {
  const store = createStore(':memory:');
  const t = 1;
  store.insertBooking({ id: 'bk1', jobId: 'j1', profileId: 'p', platform: 'fake', source: 'fake', status: 'pending_escrow', priceUsd: 5, paused: false, createdAt: t, updatedAt: t, ...o.booking });
  store.insertEscrow({ id: 'es1', bookingId: 'bk1', provider: 'solana-program', status: 'awaiting_deposit', amount: 5, currency: 'USDC', payUrl: 'solana:https%3A%2F%2Fx%2Fsolana-pay%2Fescrow%2Fbk1', createdAt: t, updatedAt: t, ...o.escrow });
  const provider: EscrowProvider = {
    name: 'solana-program', currency: 'USDC',
    create: vi.fn(), refresh: vi.fn(), release: vi.fn(), refund: vi.fn(),
    buildDepositTransaction: vi.fn(async (_e: EscrowRecord, account: string) => ({ transaction: 'BASE64TX', message: `for ${account}` })),
  };
  const app = express();
  app.use(express.json());
  mountSolanaPay(app, { store, escrow: provider, config: { PUBLIC_URL: 'https://x/', ...(o.window && { ESCROW_DEPOSIT_TIMEOUT_MIN: o.window }) }, ...(o.now !== undefined && { now: () => o.now! }) });
  const server = app.listen(0);
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, provider };
}

describe('solana pay transaction request', () => {
  const account = Keypair.generate().publicKey.toBase58();
  const post = (base: string, body: unknown) => fetch(`${base}/solana-pay/escrow/bk1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('GET returns label and icon; POST returns the deposit transaction for the account', async () => {
    const { base, provider } = await serve();
    const meta = await (await fetch(`${base}/solana-pay/escrow/bk1`)).json();
    expect(meta).toEqual({ label: 'HAAS escrow', icon: 'https://x/solana-pay/icon.svg' });
    const res = await post(base, { account });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ transaction: 'BASE64TX', message: `for ${account}` });
    expect(provider.buildDepositTransaction).toHaveBeenCalledWith(expect.objectContaining({ id: 'es1' }), account);
  });

  it('rejects bad accounts, unknown bookings and escrows no longer awaiting a deposit', async () => {
    const a = await serve();
    expect((await post(a.base, { account: 'nope' })).status).toBe(400);
    expect((await fetch(`${a.base}/solana-pay/escrow/zz`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account }) })).status).toBe(404);
    const b = await serve({ booking: { status: 'cancelled' }, escrow: { status: 'failed' } });
    expect((await post(b.base, { account })).status).toBe(409);
    expect(b.provider.buildDepositTransaction).not.toHaveBeenCalled();
  });

  it('stops handing out deposits shortly before the deposit window closes', async () => {
    const min = 60_000;
    const open = await serve({ window: 60, now: 1 + 57 * min });
    expect((await post(open.base, { account })).status).toBe(200);
    const closing = await serve({ window: 60, now: 1 + 59 * min });
    const res = await post(closing.base, { account });
    expect(res.status).toBe(409);
    expect(closing.provider.buildDepositTransaction).not.toHaveBeenCalled();
  });

  it('serves the deposit QR as a PNG', async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/solana-pay/qr/bk1.png`);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).subarray(1, 4).toString()).toBe('PNG');
    expect((await fetch(`${base}/solana-pay/qr/zz.png`)).status).toBe(404);
  });
});
