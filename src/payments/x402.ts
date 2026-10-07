// Placeholder for the x402 paywall (POST /x402/route behind Cardano payment).
// Until it is written, the route answers 501 so clients get an honest signal.

import type { Express } from 'express';
import type { ApiDeps } from '../domain/ports';

export function mountX402(app: Express, deps: ApiDeps): void {
  if (!deps.config.X402_PAY_TO) return;
  console.warn('[x402] X402_PAY_TO is set but the paywall is not implemented yet');
  app.post('/x402/route', (_req, res) => {
    res.status(501).json({ error: 'x402 paywall not implemented yet' });
  });
}
