// MIP-003 agentic service API. Without MASUMI_API_KEY and MASUMI_AGENT_IDENTIFIER jobs start unpaid and the
// start_job response mimics the pip-masumi free-agent mock: blockchainIdentifier "free_<jobId>", sellerVKey "",
// payByTime now, submitResultTime now+24h, unlockTime and externalDisputeUnlockTime now, plus `payment_required: false`.
import { randomBytes } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { MountMasumi } from '../domain/ports';
import type { Job, Shortlist } from '../domain/types';
import { inputHash } from './hash';
import { createPaymentClient, paymentsConfigured } from './payments';
import { BRIEF_SCHEMA, checkInSchema, parseBrief, parseCheckIn } from './schema';
import { createWatcher, resultString } from './watcher';

const HEX_NONCE = /^[0-9a-fA-F]{14,26}$/;

const startBody = z
  .object({
    identifier_from_purchaser: z.string().min(1).optional(),
    identifierFromPurchaser: z.string().min(1).optional(),
    input_data: z.unknown().optional(),
    inputData: z.unknown().optional(),
    input: z.unknown().optional(),
  })
  .loose();

const provideBody = z
  .object({
    job_id: z.string().min(1),
    input_schema_hash: z.string().optional(),
    input_data: z.unknown(),
  })
  .loose();

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: message, detail: message });

const handle =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown): RequestHandler =>
  async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) return void fail(res, err.status, err.message);
      console.error('[masumi] request failed:', err);
      fail(res, 500, 'internal error');
    }
  };

/** JSON body parser scoped to our routes; bad JSON is a 400, never an unhandled error. */
const json = (req: Request, res: Response, next: NextFunction) =>
  express.json({ limit: '256kb' })(req, res, (err?: unknown) => (err ? fail(res, 400, 'request body is not valid JSON') : next()));

const zodMessage = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');

const shortlistView = (s: Shortlist) =>
  s.candidates.map((c) => ({
    id: c.profile.id,
    platform: c.profile.platform,
    name: c.profile.name,
    headline: c.profile.headline,
    url: c.profile.url,
    score: c.score,
    reason: c.reason,
    unknowns: c.unknowns,
    quote_usd: c.quoteUsd ?? null,
  }));

export const mountMasumi: MountMasumi = (app, deps) => {
  const { jobs, store, config } = deps;
  const paid = paymentsConfigured(config);
  const payments = paid ? createPaymentClient(config) : undefined;
  const watcher = createWatcher(deps, payments);
  const router = Router();

  const masumiJob = (id: string): Job => {
    const job = store.getJob(id);
    if (!job || job.client !== 'masumi') throw new HttpError(404, `job ${id} not found`);
    return job;
  };
  const identifierOf = (job: Job) => job.payment?.identifierFromPurchaser ?? store.getKv(`masumi:ifp:${job.id}`) ?? job.id;

  router.get('/availability', (_req, res) => {
    res.json({ status: 'available', type: 'masumi-agent', message: 'HAAS is ready to accept jobs' });
  });

  router.get('/input_schema', (_req, res) => {
    res.json(BRIEF_SCHEMA);
  });

  router.post(
    '/start_job',
    json,
    handle(async (req, res) => {
      const body = startBody.safeParse(req.body ?? {});
      if (!body.success) throw new HttpError(400, zodMessage(body.error));
      const rawInput = body.data.input_data ?? body.data.inputData ?? body.data.input;
      const brief = parseBrief(rawInput);
      if (!brief.ok) throw new HttpError(400, brief.errors.join('; '));
      const ifp = body.data.identifier_from_purchaser ?? body.data.identifierFromPurchaser ?? randomBytes(10).toString('hex');
      // Hashed exactly as the purchaser sent it (MIP-004), not as the parsed Brief.
      const hash = inputHash(rawInput, ifp);

      if (!payments) {
        const job = jobs.startJob({ brief: brief.value, client: 'masumi' });
        store.setKv(`masumi:ifp:${job.id}`, ifp);
        const t = Date.now();
        return res.json({
          id: job.id,
          blockchainIdentifier: `free_${job.id}`,
          payByTime: t,
          submitResultTime: t + 86_400_000,
          unlockTime: t,
          externalDisputeUnlockTime: t,
          agentIdentifier: config.MASUMI_AGENT_IDENTIFIER ?? '',
          sellerVKey: '',
          identifierFromPurchaser: ifp,
          input_hash: hash,
          inputHash: hash,
          payment_required: false,
        });
      }

      if (!HEX_NONCE.test(ifp)) throw new HttpError(400, 'identifier_from_purchaser must be 14 to 26 hex characters (payment service requirement)');
      let payment;
      try {
        payment = await payments.createPayment({ inputHash: hash, identifierFromPurchaser: ifp });
      } catch (err) {
        console.error('[masumi] create payment failed:', (err as Error).message);
        throw new HttpError(500, 'could not create the payment request');
      }
      const job = jobs.startJob({ brief: brief.value, client: 'masumi', awaitPayment: true });
      store.updateJob(job.id, { payment });
      res.json({
        id: job.id,
        blockchainIdentifier: payment.blockchainIdentifier,
        payByTime: payment.payByTime,
        submitResultTime: payment.submitResultTime,
        unlockTime: payment.unlockTime,
        externalDisputeUnlockTime: payment.externalDisputeUnlockTime,
        agentIdentifier: payment.agentIdentifier,
        sellerVKey: payment.sellerVKey,
        identifierFromPurchaser: ifp,
        input_hash: hash,
        inputHash: hash,
        payment_required: true,
      });
    }),
  );

  // MIP-003 status allows `status`, `input_schema` and `result` (a string, "result or pre-result").
  // While awaiting_input, `result` is a JSON string of the shortlist and `shortlist` repeats it as an extension.
  router.get(
    '/status',
    handle((req, res) => {
      const id = typeof req.query.job_id === 'string' ? req.query.job_id : '';
      if (!id) throw new HttpError(400, 'job_id is required');
      const job = masumiJob(id);
      const out: Record<string, unknown> = { status: job.status };
      if (job.status === 'awaiting_input') {
        const shortlist = jobs.getShortlist(job.id);
        out.input_schema = checkInSchema(shortlist);
        if (shortlist) {
          const candidates = shortlistView(shortlist);
          out.result = JSON.stringify({ round: shortlist.round, candidates });
          out.shortlist = candidates;
        }
      } else if (job.status === 'completed') out.result = resultString(job);
      else if (job.status === 'failed') out.result = job.error ?? 'job failed';
      res.json(out);
    }),
  );

  router.post(
    '/provide_input',
    json,
    handle((req, res) => {
      const body = provideBody.safeParse(req.body ?? {});
      if (!body.success) throw new HttpError(400, zodMessage(body.error));
      const job = masumiJob(body.data.job_id);
      if (job.status !== 'awaiting_input') throw new HttpError(400, `job is ${job.status}, not awaiting_input`);
      const parsed = parseCheckIn(body.data.input_data, jobs.getShortlist(job.id));
      if (!parsed.ok) throw new HttpError(400, parsed.errors.join('; '));
      try {
        jobs.provideInput(job.id, parsed.value);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      // No signing key here: the reference implementation also returns an empty signature.
      res.json({ input_hash: inputHash(body.data.input_data, identifierOf(job)), signature: '' });
    }),
  );

  app.use(router);
  return { start: () => watcher.start(), stop: () => watcher.stop() };
};
