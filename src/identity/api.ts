// Read-only HTTP endpoints for the dashboard and the demo.
//   GET /identity                              policy, operator address, network, explorer links
//   GET /workers/:id/reputation                credential, on-chain check, reputation, receipts
//   GET /workers/by-wallet/:address/reputation same, looked up by Cardano address

import { Router, type Express, type Request, type Response } from 'express';
import { explorer } from './cip68';
import type { Identity } from './index';
import { workerView } from './registry';

const READ_TIMEOUT_MS = 4_000;

export function mountIdentity(app: Express, identity: Identity | null): void {
  const r = Router();

  const off = (res: Response) =>
    res.status(503).json({ error: 'identity is not configured: set BLOCKFROST_PROJECT_ID and CARDANO_MINT_MNEMONIC', detail: 'see docs/IDENTITY.md' });

  r.get('/identity', async (_req, res) => {
    if (!identity) return void off(res);
    try {
      const { registry } = identity;
      const ex = explorer(registry.network);
      const [policyId, operator] = await Promise.all([registry.chain.policyId(), registry.chain.operatorAddress()]);
      res.json({ network: registry.network, chain: registry.chain.kind, issuer: identity.issuer.kind, policyId, operator, workers: registry.knownWorkers().length, links: { policy: ex.policy(policyId), operator: ex.address(operator) } });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  async function send(req: Request, res: Response, workerId: string | undefined) {
    if (!identity) return void off(res);
    const { registry, minter } = identity;
    if (!workerId) return void res.status(404).json({ error: 'unknown worker' });
    const pending = minter.tasks({ workerId, open: true });
    const known = registry.walletOf(workerId) || registry.credentialOf(workerId) || registry.receiptsOf(workerId).length > 0 || pending.length > 0;
    if (!known) return void res.status(404).json({ error: `worker ${workerId} has no HAAS identity yet` });
    // Wait briefly for a fresh chain read; fall back to the cache (stale data says when it was checked).
    if (req.query.refresh !== '0') await registry.refresh(workerId, READ_TIMEOUT_MS).catch(() => null);
    res.json(workerView(registry, workerId, { pending }));
  }

  r.get('/workers/by-wallet/:address/reputation', (req, res) => void send(req, res, identity?.registry.workerByWallet(String(req.params.address))));
  r.get('/workers/:id/reputation', (req, res) => void send(req, res, String(req.params.id)));

  app.use(r);
}
