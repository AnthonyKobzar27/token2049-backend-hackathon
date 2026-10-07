// MIP-003 agentic service API (masumi-improvement-proposals MIPs/MIP-003, 2026-03-03 revision).
//
// Spec fields are always present; extensions are additive and named in comments:
//   start_job  + job_id (= id) and status "success": Masumi's own buyer clients (masumi-mcp-server) read job_id.
//              + amounts / paymentSourceType / supportedPaymentSourceIndex / smartContractAddress: what a buyer
//                must echo into the payment service's POST /purchase for a Dynamic-priced V2 agent.
//              + payment_required, inputHash (camelCase twin of input_hash).
//   status     + job_id; + shortlist (the check-in candidates, also JSON in `result`); + payment (escrow state and
//                the seller collection tx hash; kept out of `result`, whose hash is fixed once submitted).
//   provide_input: input_schema_hash must equal sha256(JCS(input_schema)) of the schema /status issued; a mismatch
//                is a 400. A missing hash is accepted only with MASUMI_LENIENT_SCHEMA_HASH=true. The response
//                signature is Ed25519 over the UTF-8 input_hash, verifiable with GET /signing_key.
//   demo       (optional in MIP-003) sample input and output.
//
// Without MASUMI_API_KEY and MASUMI_AGENT_IDENTIFIER jobs start unpaid and the start_job response mimics the
// pip-masumi free-agent mock: blockchainIdentifier "free_<jobId>", sellerVKey "", payByTime now, submitResultTime
// now+24h, unlockTime and externalDisputeUnlockTime now, plus `payment_required: false`.
import { randomBytes } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { newId } from '../domain/ids';
import type { MountMasumi } from '../domain/ports';
import type { Job, JobPayment, Shortlist } from '../domain/types';
import { inputHash, schemaHash } from './hash';
import { createPaymentClient, paymentsConfigured } from './payments';
import { formatAmount, quoteFee } from './pricing';
import { BRIEF_SCHEMA, checkInSchema, parseBrief, parseCheckIn } from './schema';
import { loadSigner } from './signing';
import { createWatcher, resultString } from './watcher';

const HEX_NONCE = /^[0-9a-fA-F]{14,26}$/;
const HEX64 = /^[0-9a-f]{64}$/;

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
    verified: c.identity?.verified ?? false,
    ...(c.identity && { verified_by: c.identity.by, jobs_on_chain: c.identity.jobsCompleted }),
  }));

/** Extra start_job fields a buyer needs for POST /purchase on a V2, Dynamic-priced agent. */
const purchaseHints = (p: JobPayment) => ({
  ...(p.amounts ? { amounts: p.amounts, price: p.amounts.map(formatAmount).join(' + ') } : {}),
  ...(p.paymentSourceType ? { paymentSourceType: p.paymentSourceType } : {}),
  ...(p.supportedPaymentSourceIndex !== undefined ? { supportedPaymentSourceIndex: p.supportedPaymentSourceIndex } : {}),
  ...(p.smartContractAddress ? { smartContractAddress: p.smartContractAddress } : {}),
});

/** MIP-003 /demo: example input and output, no job is run. */
export const DEMO = {
  input: {
    task: 'Photograph a 40-person product launch in Lisbon and deliver 50 edited photos',
    skills: 'event photography, photo editing',
    budget_usd: 600,
    deadline_days: 10,
    location: 'Lisbon, Portugal',
    remote_ok: false,
    hours_needed: 4,
    language: 'en',
  },
  output: {
    result: JSON.stringify({
      outcome: 'booked',
      summary: 'Booked Ana Ribeiro on freelancer for $480.',
      freelancer: { id: 'freelancer:123456', platform: 'freelancer', name: 'Ana Ribeiro', url: 'https://www.freelancer.com/u/anaribeiro', headline: 'Event and portrait photographer, Lisbon' },
      priceUsd: 480,
    }),
  },
};

export const mountMasumi: MountMasumi = (app, deps) => {
  const { jobs, store, config } = deps;
  const paid = paymentsConfigured(config);
  const payments = paid ? createPaymentClient(config) : undefined;
  const watcher = createWatcher(deps, payments);
  const signer = loadSigner({ seed: config.MASUMI_SIGNING_KEY, getKv: (k) => store.getKv(k), setKv: (k, v) => store.setKv(k, v) });
  /** start_job requests in flight, by input hash: a concurrent retry waits for the first answer. */
  const starting = new Map<string, Promise<string | undefined>>();
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

  router.get('/demo', (_req, res) => {
    res.json(DEMO);
  });

  // Not in MIP-003: how to verify /provide_input signatures.
  router.get('/signing_key', (_req, res) => {
    res.json({
      algorithm: 'Ed25519',
      public_key: signer.publicKey,
      encoding: 'hex',
      signed_message: 'the UTF-8 bytes of the input_hash string returned by /provide_input',
    });
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
      const given = body.data.identifier_from_purchaser ?? body.data.identifierFromPurchaser;
      const ifp = given ?? randomBytes(10).toString('hex');
      // Hashed exactly as the purchaser sent it (MIP-004), not as the parsed Brief.
      const hash = inputHash(rawInput, ifp);

      // A retry (same identifier_from_purchaser, same input) gets the same job and payment request,
      // never a second job that could book or charge twice.
      const onceKey = `masumi:start:${hash}`;
      if (given) {
        const prior = store.getKv(onceKey) ?? (await starting.get(onceKey));
        if (prior) return res.json(JSON.parse(prior));
      }
      const respond = (out: Record<string, unknown>) => {
        if (given) store.setKv(onceKey, JSON.stringify(out));
        return res.json(out);
      };
      let done!: (v: string | undefined) => void;
      if (given) starting.set(onceKey, new Promise((r) => (done = r)));
      try {
        if (!payments) {
          const job = jobs.startJob({ brief: brief.value, client: 'masumi' });
          store.setKv(`masumi:ifp:${job.id}`, ifp);
          const t = Date.now();
          return respond({
            id: job.id,
            job_id: job.id,
            status: 'success',
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
        const jobId = newId('job');
        let payment: JobPayment;
        try {
          payment = await payments.createPayment({
            inputHash: hash,
            identifierFromPurchaser: ifp,
            amounts: [quoteFee(brief.value, config)],
            metadata: JSON.stringify({ haasJobId: jobId }),
          });
        } catch (err) {
          console.error('[masumi] create payment failed:', (err as Error).message);
          throw new HttpError(500, 'could not create the payment request');
        }
        const job = jobs.startJob({ brief: brief.value, client: 'masumi', awaitPayment: true, id: jobId });
        store.updateJob(job.id, { payment });
        return respond({
          id: job.id,
          job_id: job.id,
          status: 'success',
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
          ...purchaseHints(payment),
        });
      } finally {
        if (given) {
          done(store.getKv(onceKey) ?? undefined);
          starting.delete(onceKey);
        }
      }
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
      const out: Record<string, unknown> = { job_id: job.id, status: job.status };
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
      const p = job.payment;
      if (p) {
        out.payment = {
          blockchainIdentifier: p.blockchainIdentifier,
          onChainState: p.onChainState ?? (p.paidAt ? 'FundsLocked' : null),
          submitResultTime: p.submitResultTime,
          unlockTime: p.unlockTime,
          result_hash: p.resultHash ?? null,
          collection_tx_hash: p.collectionTxHash ?? null,
        };
      }
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
      const shortlist = jobs.getShortlist(job.id);
      const given = body.data.input_schema_hash?.trim().toLowerCase();
      if (given === undefined || given === '') {
        if (!config.MASUMI_LENIENT_SCHEMA_HASH) throw new HttpError(400, 'input_schema_hash is required: sha256 of the canonical JSON (RFC 8785) of the input_schema from /status');
      } else {
        const expected = schemaHash(checkInSchema(shortlist));
        if (!HEX64.test(given) || given !== expected) {
          throw new HttpError(400, 'input_schema_hash does not match the input_schema currently issued by /status; fetch /status again');
        }
      }
      const parsed = parseCheckIn(body.data.input_data, shortlist);
      if (!parsed.ok) throw new HttpError(400, parsed.errors.join('; '));
      try {
        jobs.provideInput(job.id, parsed.value);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      const hash = inputHash(body.data.input_data, identifierOf(job));
      res.json({ input_hash: hash, signature: signer.sign(hash) });
    }),
  );

  app.use(router);
  return { start: () => watcher.start(), stop: () => watcher.stop() };
};
