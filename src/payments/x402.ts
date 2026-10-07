// x402 paywall in front of the routing API, chain-pluggable: one 402 can offer Cardano (USDM, or
// tADA) and Solana (USDC) at once, and the client pays on whichever it supports. POST /x402/route
// costs X402_PRICE_USD; job status and check-in answers stay unpaid (the job id is the capability).
// Networks, assets and facilitators come from src/payments/x402-networks.ts.
//
// Both chains use the x402 "authorization" flow: the handler runs after /verify, its response is
// held back, and the facilitator settles (Cardano: broadcasts the client's signed tx and waits for
// the confirmation policy; Solana: co-signs as fee payer and submits) before the response is
// released. The job is started in the after-settle hook, never before the money moved, under an
// id derived from the payment so a retried paid request cannot start a second job. The brief
// waiting for settlement is kept in the Store, so a restart does not lose it.

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { x402ResourceServer, paymentMiddleware } from '@x402/express';
import { HTTPFacilitatorClient, type RoutesConfig } from '@x402/core/server';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { ExactCardanoScheme } from '@x402/cardano/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { enrichBrief } from '../agent/extract';
import type { ApiDeps, MountX402 } from '../domain/ports';
import type { Brief, PaymentSettlement, UserInput } from '../domain/types';
import { explorerUrl, networkLabel, paymentKey, resolveAccepts } from './x402-networks';

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
  when: z.object({ date: z.string().optional(), window: z.object({ start: z.string(), end: z.string() }).optional(), timezone: z.string().optional() }).optional(),
  radiusKm: z.number().positive().optional(),
  taskType: z.enum(['in_person', 'remote_creative', 'remote_technical', 'remote_general']).optional(),
});

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), profileId: z.string().min(1) }),
  z.object({ action: z.literal('refine'), feedback: z.string(), brief: briefSchema.partial().optional() }),
  z.object({ action: z.literal('cancel') }),
]);

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);

/** Job id for a paid request: stable per payment (see paymentKey). */
export const jobIdForTx = (txHash: string): string => `job_${txHash.slice(0, 12).toLowerCase()}`;

/** Store key of the brief of a paid request waiting for settlement. */
export const pendingKey = (jobId: string) => `x402:pending:${jobId}`;

interface Pending {
  brief: Brief;
  network: string;
  at: number;
}

/** Payment key, network and job id of a PAYMENT-SIGNATURE header, or undefined when it does not parse. */
function paidRequest(header: string | undefined): { key: string; network: string; id: string } | undefined {
  if (!header) return undefined;
  try {
    const p = decodePaymentSignatureHeader(header);
    const network = String(p.accepted?.network ?? '');
    const key = paymentKey(network, p.payload as Record<string, unknown>);
    return { key, network, id: jobIdForTx(key) };
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
    const id = String(req.params.id);
    // Paid, settlement still in flight: the job starts once the payment is on chain.
    const pending = !jobs.getJob(id) && deps.store.getKv(pendingKey(id));
    if (pending) {
      const p = JSON.parse(pending) as Pending;
      return void res.json({ job_id: id, status: 'awaiting_payment', network: p.network, brief: p.brief });
    }
    const job = ownJob(req, res);
    if (!job) return;
    const body: Record<string, unknown> = { job_id: job.id, status: job.status, round: job.round, brief: job.brief };
    if (job.settlement) body.settlement = job.settlement;
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
  const { accepts, skipped } = resolveAccepts(config);
  for (const why of skipped) console.log(`x402: not offering ${why}`);
  if (accepts.length === 0) {
    console.log('x402 disabled (no payable network: set X402_PAY_TO for Cardano and/or X402_SOLANA_PAY_TO for Solana)');
    return;
  }
  const { store } = deps;

  // Bad bodies are rejected before payment, so nobody pays for a request that cannot run.
  const validate = (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST') return next();
    const parsed = briefSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: 'invalid brief', details: issues(parsed.error) });
    res.locals.brief = enrichBrief(parsed.data as Brief);
    next();
  };
  app.use('/x402/route', json, validate);

  // Earlier facilitators win per network; one that is down at startup is skipped, so the
  // self-hosted Cardano facilitator takes over when the hosted one is unreachable.
  // The timeout must exceed the Cardano facilitator's own settlement wait (75 s by default).
  const urls = [...new Set(accepts.flatMap((a) => a.facilitators))];
  const server = new x402ResourceServer(urls.map((url) => new HTTPFacilitatorClient({ url, timeoutMs: 120_000 })));
  for (const a of accepts) server.register(a.network, a.chain === 'cardano' ? new ExactCardanoScheme() : new ExactSvmScheme());

  server.onAfterSettle(async ({ paymentPayload, requirements, result }) => {
    if (!result.success) return;
    try {
      const network = String(requirements.network);
      const id = jobIdForTx(paymentKey(network, paymentPayload.payload as Record<string, unknown>));
      const accepted = accepts.find((a) => a.network === network);
      const settlement: PaymentSettlement = {
        protocol: 'x402',
        network,
        asset: accepted?.symbol ?? String(requirements.asset),
        amount: String(result.amount ?? requirements.amount),
        transaction: result.transaction,
        explorerUrl: explorerUrl(network, result.transaction),
        payer: result.payer,
        settledAt: Date.now(),
      };
      // Idempotent: a job exists at most once per payment, whatever retries or restarts happen.
      if (jobs.getJob(id)) {
        if (!store.getJob(id)?.settlement) store.updateJob(id, { settlement });
        return;
      }
      const raw = store.getKv(pendingKey(id));
      if (!raw) return void console.error(`x402: settled ${result.transaction} but no pending brief for ${id}`);
      const pending = JSON.parse(raw) as Pending;
      jobs.startJob({ brief: pending.brief, client: 'x402', id });
      store.updateJob(id, { settlement });
      store.setKv(pendingKey(id), '');
    } catch (e) {
      console.error('x402: could not start the job after settlement:', e instanceof Error ? e.message : e);
    }
  });

  const routes: RoutesConfig = {
    'POST /x402/route': {
      accepts: accepts.map((a) => ({
        scheme: 'exact',
        network: a.network,
        payTo: a.payTo,
        price: { amount: a.amount, asset: a.asset },
        maxTimeoutSeconds: 600,
        extra: a.extra,
      })),
      description: 'HAAS routing: search freelancer platforms, rank candidates, book the one you confirm',
      mimeType: 'application/json',
    },
  };
  app.use(paymentMiddleware(routes, server));

  app.post('/x402/route', (req, res) => {
    const brief = res.locals.brief as Brief;
    const paid = paidRequest(req.get('payment-signature') ?? undefined);
    if (!paid) return void res.status(400).json({ error: 'missing payment' });
    // First brief per payment wins: a retry (even after a restart) cannot swap the paid request.
    if (!jobs.getJob(paid.id) && !store.getKv(pendingKey(paid.id))) {
      store.setKv(pendingKey(paid.id), JSON.stringify({ brief, network: paid.network, at: Date.now() } satisfies Pending));
    }
    res.status(202).json({ job_id: paid.id, status_url: `${publicUrl}/x402/jobs/${paid.id}` });
  });

  const offer = accepts.map((a) => `${(Number(a.amount) / 10 ** a.decimals).toString()} ${a.symbol} on ${networkLabel(a.network)}`).join(' or ');
  console.log(`x402 enabled: POST /x402/route costs ${offer}; facilitators ${urls.join(', ')}`);
};
