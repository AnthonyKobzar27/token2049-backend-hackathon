// Placeholder for the Masumi MIP-003 agent API. Jobs can still be started from
// Telegram and the dashboard; MIP-003 routes answer 501 until this is written.

import type { Express } from 'express';
import type { ApiDeps } from '../domain/ports';

export function mountMasumi(app: Express, deps: ApiDeps): { start(): void; stop(): void } {
  if (deps.config.MASUMI_API_KEY) {
    console.warn('[masumi] MASUMI_API_KEY is set but the MIP-003 API is not implemented yet');
  }
  for (const route of ['/start_job', '/status', '/provide_input'] as const) {
    app.all(route, (_req, res) => {
      res.status(501).json({ error: 'Masumi MIP-003 API not implemented yet' });
    });
  }
  return { start() {}, stop() {} };
}
