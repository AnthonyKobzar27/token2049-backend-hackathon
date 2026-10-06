// x402 paywall on Cardano in front of the routing API. POST /x402/route costs
// X402_PRICE_LOVELACE; job status and check-in answers stay unpaid (the job id is the capability).
//
// Cardano uses the x402 "authorization" flow: the handler runs after /verify, its response is
// held back, and the facilitator broadcasts the client's signed transaction and waits for the
// confirmation policy (bounded, default 75 s, retried once by core) before the response is released.
// So the 202 reaches the payer only once the payment is on chain. The job is started in the
// after-settle hook, never before the money moved, under an id derived from the tx hash so a
// retried paid request cannot start a second job.

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { x402ResourceServer, paymentMiddleware } from '@x402/express';
import { HTTPFacilitatorClient, type RoutesConfig } from '@x402/core/server';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { decodeCardanoTransaction } from '@x402/cardano';
import { ExactCardanoScheme } from '@x402/cardano/exact/server';
import type { ApiDeps, MountX402 } from '../domain/ports';
import type { Brief, UserInput } from '../domain/types';

/** Evidence required before the 202 is released: 0 = the tx is in a block (about 20 s on average). */
const L1_CONFIRMATIONS = 0;

const briefSchema = z.object({
  task: z.string().trim().min(1),
  skills: z.array(z.string()).default([]),
  budgetUsd: z.number().positive().optional(),
  deadlineDays: z.number().positive().optional(),
  location: z.string().optional(),
  timezone: z.string().optional(),
  remoteOk: z.boolean().default(true),
  hoursNeeded: z.number().positive().optional(),
  language: z.string().optional(),
  notes: z.string().optional(),
});

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), profileId: z.string().min(1) }),
  z.object({ action: z.literal('refine'), feedback: z.string(), brief: briefSchema.partial().optional() }),
  z.object({ action: z.literal('cancel') }),
]);

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);

/** Job id for a paid request: stable per payment transaction. */
export const jobIdForTx = (txHash: string): string => `job_${txHash.slice(0, 12).toLowerCase()}`;

function txHashOf(header: string | undefined): string | undefined {
  if (!header) return undefined;
  try {
    return decodeCardanoTransaction(String(decodePaymentSignatureHeader(header).payload.transaction)).txHash;
  } catch {
    return undefined;
  }
}

export const mountX402: MountX402 = (app: Express, deps: ApiDeps) => {
  const { jobs, config } = deps;
  const publicUrl = config.PUBLIC_URL.replace(/\/$/, '');

  // ---- unpaid job routes (mounted even when the paywall is off, so the status URL always works)
  const json = express.json({ limit: '256kb' });
  const ownJob = (req: Request, res: Response) => {
    const job = jobs.getJob(String(req.params.id));
    if (!job || job.client !== 'x402') {
      res.status(404).json({ error: 'job not found' });
      return undefined;
    }
    return job;
  };

  app.get('/x402/jobs/:id', (req, res) => {
    const job = ownJob(req, res);
    if (!job) return;
    const body: Record<string, unknown> = { job_id: job.id, status: job.status, round: job.round, brief: job.brief };
    if (job.status === 'awaiting_input') {
      const sl = jobs.getShortlist(job.id);
      body.candidates = (sl?.candidates ?? []).map((c) => ({
        profile_id: c.profile.id,
        name: c.profile.name,
        platform: c.profile.platform,
        url: c.profile.url,
        headline: c.profile.headline,
        score: c.score,
        reason: c.reason,
        quote_usd: c.quoteUsd,
        unknowns: c.unknowns,
      }));
    }
    if (job.status === 'completed' && job.result) body.result = job.result;
    if (job.error) body.error = job.error;
    res.json(body);
  });

  app.post('/x402/jobs/:id/input', json, (req, res) => {
    const job = ownJob(req, res);
    if (!job) return;
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid input', details: issues(parsed.error) });
    if (job.status !== 'awaiting_input') return void res.status(409).json({ error: `job is '${job.status}', not awaiting input` });
    try {
      const updated = jobs.provideInput(job.id, parsed.data as UserInput);
      res.json({ job_id: updated.id, status: updated.status });
    } catch (e) {
      res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ---- the paywalled route
  if (!config.X402_PAY_TO) {
    console.log('x402 disabled (X402_PAY_TO not set)');
    return;
  }

  /** Briefs of paid requests waiting for settlement, by tx hash. */
  const pending = new Map<string, Brief>();

  // Bad bodies are rejected before payment, so nobody pays for a request that cannot run.
  const validate = (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST') return next();
    const parsed = briefSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid brief', details: issues(parsed.error) });
    res.locals.brief = parsed.data as Brief;
    next();
  };
  app.use('/x402/route', json, validate);

  const facilitator = new HTTPFacilitatorClient({
    url: config.X402_FACILITATOR_URL,
    // Must exceed the facilitator's own settlement wait (75 s by default).
    timeoutMs: 120_000,
  });
  const server = new x402ResourceServer(facilitator).register(config.X402_NETWORK as `${string}:${string}`, new ExactCardanoScheme());

  server.onAfterSettle(async ({ paymentPayload, result }) => {
    if (!result.success) return;
    try {
      const txHash = decodeCardanoTransaction(String(paymentPayload.payload.transaction)).txHash;
      const id = jobIdForTx(txHash);
      const brief = pending.get(txHash);
      pending.delete(txHash);
      if (!brief || jobs.getJob(id)) return;
      jobs.startJob({ brief, client: 'x402', id });
    } catch (e) {
      console.error('x402: could not start the job after settlement:', e instanceof Error ? e.message : e);
    }
  });

  const routes: RoutesConfig = {
    'POST /x402/route': {
      accepts: {
        scheme: 'exact',
        network: config.X402_NETWORK as `${string}:${string}`,
        payTo: config.X402_PAY_TO,
        price: { amount: String(config.X402_PRICE_LOVELACE), asset: 'lovelace' },
        maxTimeoutSeconds: 600,
        extra: { assetTransferMethod: 'default', areFeesSponsored: false, confirmationPolicy: { l1Confirmations: L1_CONFIRMATIONS } },
      },
      description: 'HAAS routing: search freelancer platforms, rank candidates, book the one you confirm',
      mimeType: 'application/json',
    },
  };
  app.use(paymentMiddleware(routes, server));

  app.post('/x402/route', (req, res) => {
    const brief = res.locals.brief as Brief;
    const txHash = txHashOf(req.get('payment-signature') ?? undefined);
    if (!txHash) return void res.status(400).json({ error: 'missing payment' });
    pending.set(txHash, brief);
    if (pending.size > 1000) pending.delete(pending.keys().next().value!);
    const id = jobIdForTx(txHash);
    res.status(202).json({ job_id: id, status_url: `${publicUrl}/x402/jobs/${id}` });
  });

  console.log(`x402 enabled: POST /x402/route costs ${config.X402_PRICE_LOVELACE} lovelace on ${config.X402_NETWORK}, facilitator ${config.X402_FACILITATOR_URL}`);
};
