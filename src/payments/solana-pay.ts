// Solana Pay transaction request endpoint for escrow deposits.
// The QR (escrow.payUrl) is `solana:<PUBLIC_URL>/solana-pay/escrow/<bookingId>`; the wallet
// GETs a label, then POSTs { account } and receives the deposit transaction to sign.
// Spec: https://docs.solanapay.com/spec#specification-transaction-request

import type { Express, Request, Response, NextFunction } from 'express';
import { PublicKey } from '@solana/web3.js';
import type { EscrowProvider, Store } from '../domain/ports';

export interface SolanaPayDeps {
  store: Store;
  escrow: EscrowProvider;
  config: { PUBLIC_URL: string };
}

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#14151a"/><text x="32" y="42" font-family="sans-serif" font-size="24" font-weight="700" fill="#14f195" text-anchor="middle">HA</text></svg>`;

export function mountSolanaPay(app: Express, deps: SolanaPayDeps): void {
  const { store, escrow: provider, config } = deps;
  const base = config.PUBLIC_URL.replace(/\/$/, '');

  const cors = (_req: Request, res: Response, next: NextFunction) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    next();
  };
  app.use('/solana-pay', cors);
  app.options('/solana-pay/escrow/:bookingId', (_req, res) => void res.sendStatus(204));

  app.get('/solana-pay/icon.svg', (_req, res) => void res.type('image/svg+xml').send(ICON));

  app.get('/solana-pay/escrow/:bookingId', (_req, res) => {
    res.json({ label: 'HAAS escrow', icon: `${base}/solana-pay/icon.svg` });
  });

  app.post('/solana-pay/escrow/:bookingId', async (req, res) => {
    const bookingId = String(req.params.bookingId);
    const account = typeof req.body?.account === 'string' ? req.body.account : '';
    try {
      new PublicKey(account);
    } catch {
      res.status(400).json({ error: 'body.account must be a base58 wallet address' });
      return;
    }
    if (!provider.buildDepositTransaction) {
      res.status(400).json({ error: `escrow provider ${provider.name} does not use transaction requests` });
      return;
    }
    const booking = store.getBooking(bookingId);
    const esc = store.getEscrowByBooking(bookingId);
    if (!booking || !esc) {
      res.status(404).json({ error: 'unknown booking' });
      return;
    }
    if (booking.status !== 'pending_escrow' || esc.status !== 'awaiting_deposit') {
      res.status(409).json({ error: `booking is ${booking.status} and escrow is ${esc.status}; no deposit is expected` });
      return;
    }
    try {
      res.json(await provider.buildDepositTransaction(esc, account));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
