// Solana Pay transaction request endpoint for escrow deposits.
// The QR (escrow.payUrl) is `solana:<PUBLIC_URL>/solana-pay/escrow/<bookingId>`; the wallet
// GETs a label, then POSTs { account } and receives the deposit transaction to sign.
// Spec: https://docs.solanapay.com/spec#specification-transaction-request

import type { Express, Request, Response, NextFunction } from 'express';
import { PublicKey } from '@solana/web3.js';
import QRCode from 'qrcode';
import type { EscrowProvider, Store } from '../domain/ports';

export interface SolanaPayDeps {
  store: Store;
  escrow: EscrowProvider;
  /** With ESCROW_DEPOSIT_TIMEOUT_MIN, no deposit is handed out that could land after the booking is cancelled. */
  config: { PUBLIC_URL: string; ESCROW_DEPOSIT_TIMEOUT_MIN?: number };
  now?: () => number;
}

/** A signed deposit can still land this long after it was built (blockhash lifetime plus slack). */
const DEPOSIT_LANDING_MS = 2 * 60_000;

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#14151a"/><text x="32" y="42" font-family="sans-serif" font-size="24" font-weight="700" fill="#14f195" text-anchor="middle">HA</text></svg>`;

const page = (title: string, body: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#14151a;color:#eee;margin:0;padding:24px;text-align:center}main{max-width:420px;margin:0 auto}h1{font-size:22px}.amt{font-size:34px;font-weight:700;color:#14f195;margin:8px 0}p{color:#aaa;line-height:1.4}a.btn{display:block;background:#14f195;color:#14151a;font-weight:700;padding:16px;border-radius:12px;text-decoration:none;margin:20px 0;font-size:18px}img{width:260px;height:260px;border-radius:12px;background:#fff;padding:8px}code{display:block;word-break:break-all;background:#222;padding:10px;border-radius:8px;font-size:12px;color:#ccc}</style></head><body><main>${body}</main></body></html>`;

const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * GET /pay/:bookingId: a phone-friendly page with the amount, the deadline, the QR (for a second device)
 * and an "Open in wallet" button that follows the solana: link. Chat apps cannot link a solana: URL
 * directly, and a phone cannot scan its own screen; this page bridges both. Works for every escrow
 * provider that sets payUrl or an address.
 */
export function mountPayPage(app: Express, deps: { store: Store; config: { PUBLIC_URL: string; SOLANA_RPC_URL?: string } }): void {
  const { store, config } = deps;
  app.get('/pay/:bookingId', (req, res) => {
    const bookingId = String(req.params.bookingId);
    const esc = store.getEscrowByBooking(bookingId);
    if (!esc) {
      res.status(404).type('html').send(page('Unknown booking', '<h1>Unknown booking</h1><p>There is no escrow for this booking.</p>'));
      return;
    }
    const amount = `${esc.amount} ${esc.currency}`;
    if (esc.status !== 'awaiting_deposit') {
      res.type('html').send(page('HAAS escrow', `<h1>HAAS escrow</h1><div class="amt">${amount}</div><p>This escrow is <b>${escHtml(esc.status)}</b>. Nothing more to pay.</p>`));
      return;
    }
    const devnet = (config.SOLANA_RPC_URL ?? '').includes('devnet');
    const deadline = esc.deadline ? `<p>Not accepted by ${new Date(esc.deadline).toISOString().slice(0, 16).replace('T', ' ')} UTC: the money goes back to you.</p>` : '';
    const parts = [`<h1>Pay into HAAS escrow</h1><div class="amt">${amount}</div>`];
    if (devnet) parts.push('<p>Test setup: switch your wallet to <b>devnet</b> first.</p>');
    if (esc.payUrl) {
      parts.push(`<a class="btn" href="${escHtml(esc.payUrl)}">Open in wallet</a>`);
      parts.push(`<p>Or scan from another device:</p><img alt="Solana Pay QR" src="${escHtml(config.PUBLIC_URL.replace(/\/$/, ''))}/pay/${encodeURIComponent(bookingId)}/qr.png">`);
      parts.push(`<p>Or paste into your wallet:</p><code>${escHtml(esc.payUrl)}</code>`);
    } else if (esc.address) {
      parts.push(`<p>Send ${amount} to:</p><code>${escHtml(esc.address)}</code>`);
    }
    parts.push(deadline, '<p>I will tell you in the chat when the deposit arrives.</p>');
    res.type('html').send(page('Pay into HAAS escrow', parts.join('')));
  });
  app.get('/pay/:bookingId/qr.png', async (req, res) => {
    const esc = store.getEscrowByBooking(String(req.params.bookingId));
    if (!esc?.payUrl) {
      res.status(404).json({ error: 'unknown booking' });
      return;
    }
    res.type('image/png').send(await QRCode.toBuffer(esc.payUrl, { width: 480, margin: 2 }));
  });
}

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

  // The deposit QR as a PNG, for a web page or a demo screen.
  app.get('/solana-pay/qr/:bookingId.png', async (req, res) => {
    const esc = store.getEscrowByBooking(String(req.params.bookingId));
    if (!esc?.payUrl) {
      res.status(404).json({ error: 'unknown booking' });
      return;
    }
    res.type('image/png').send(await QRCode.toBuffer(esc.payUrl, { width: 480, margin: 2 }));
  });

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
    // Too close to the deposit window's end: the booking may be cancelled before the deposit lands,
    // and the funds would then sit in the escrow until its deadline.
    const windowMin = config.ESCROW_DEPOSIT_TIMEOUT_MIN;
    if (windowMin && (deps.now ?? Date.now)() >= esc.createdAt + windowMin * 60_000 - DEPOSIT_LANDING_MS) {
      res.status(409).json({ error: 'the deposit window for this booking is closing; ask for a new booking' });
      return;
    }
    try {
      res.json(await provider.buildDepositTransaction(esc, account));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
