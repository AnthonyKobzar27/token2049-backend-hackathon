// Loopback stand-ins for tests: a MIP-003 seller agent, the buyer payment service and a registry.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { inputHash, resultHash } from '../hash';

export interface FakeSellerOptions {
  /** Output the agent returns, or a function of the received input. */
  output?: string | ((input: Record<string, unknown>) => string);
  /** Polls answered 'running' before 'completed'. */
  runningPolls?: number;
  /** Ask for payment (no payment_required=false, real-looking blockchainIdentifier). */
  paid?: boolean;
  /** Return a result_hash in /status: 'good' (matches), 'bad' (wrong), or none. */
  resultHash?: 'good' | 'bad';
  failWith?: string;
  /** Never finish. */
  hang?: boolean;
}

export interface Fake {
  url: string;
  log: { method: string; path: string; body: any; token?: string }[];
  close(): Promise<void>;
}

async function listen(app: express.Express): Promise<{ url: string; server: Server }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

function base(): { app: express.Express; log: Fake['log'] } {
  const log: Fake['log'] = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    log.push({ method: req.method, path: req.path, body: req.body, token: req.header('token') ?? undefined });
    next();
  });
  return { app, log };
}

const done = (server: Server) => () => new Promise<void>((r) => server.close(() => r()));

export async function fakeSeller(opts: FakeSellerOptions = {}): Promise<Fake & { jobs: Map<string, { ifp: string; input: Record<string, unknown>; polls: number }> }> {
  const { app, log } = base();
  const jobs = new Map<string, { ifp: string; input: Record<string, unknown>; polls: number }>();
  let n = 0;
  app.get('/input_schema', (_req, res) =>
    res.json({
      input_data: [
        { id: 'style', type: 'option', name: 'Style', data: { values: ['short', 'long'] } },
        { id: 'text', type: 'string', name: 'Text' },
        { id: 'notes', type: 'string', name: 'Notes', validations: [{ validation: 'optional', value: 'true' }] },
      ],
    }),
  );
  app.post('/start_job', (req, res) => {
    const ifp = req.body.identifier_from_purchaser as string;
    const input = req.body.input_data as Record<string, unknown>;
    const id = `sj_${++n}`;
    jobs.set(id, { ifp, input, polls: 0 });
    const t = 1_700_000_000_000;
    res.json({
      id,
      blockchainIdentifier: opts.paid ? `bc_${id}` : `free_${id}`,
      payByTime: t,
      submitResultTime: t + 3_600_000,
      unlockTime: t + 7_200_000,
      externalDisputeUnlockTime: t + 10_800_000,
      agentIdentifier: 'agent_abc',
      sellerVKey: 'vkey_seller',
      identifierFromPurchaser: ifp,
      input_hash: inputHash(input, ifp),
      ...(opts.paid ? {} : { payment_required: false }),
    });
  });
  app.get('/status', (req, res) => {
    const job = jobs.get(String(req.query.job_id));
    if (!job) return void res.status(404).json({ error: 'not found' });
    job.polls++;
    if (opts.hang || job.polls <= (opts.runningPolls ?? 1)) return void res.json({ status: 'running' });
    if (opts.failWith) return void res.json({ status: 'failed', result: opts.failWith });
    const output = typeof opts.output === 'function' ? opts.output(job.input) : (opts.output ?? `Done: ${String(job.input.text)}`);
    const out: Record<string, unknown> = { status: 'completed', result: output };
    if (opts.resultHash === 'good') out.result_hash = resultHash(output, job.ifp);
    if (opts.resultHash === 'bad') out.result_hash = 'deadbeef';
    res.json(out);
  });
  const { url, server } = await listen(app);
  return { url, log, jobs, close: done(server) };
}

export async function fakePaymentService(): Promise<Fake> {
  const { app, log } = base();
  app.post('/purchase/', (req, res) => res.json({ status: 'success', data: { id: 'pur_1', blockchainIdentifier: req.body.blockchainIdentifier } }));
  app.post('/purchase/request-refund', (req, res) => res.json({ status: 'success', data: { blockchainIdentifier: req.body.blockchainIdentifier } }));
  app.post('/purchase/resolve-blockchain-identifier', (_req, res) => res.json({ status: 'success', data: { resultHash: null } }));
  const { url, server } = await listen(app);
  return { url, log, close: done(server) };
}

export async function fakeRegistry(entries: Record<string, unknown>[]): Promise<Fake> {
  const { app, log } = base();
  app.post('/registry-entry-search/', (_req, res) => res.json({ status: 'success', data: { entries } }));
  const { url, server } = await listen(app);
  return { url, log, close: done(server) };
}
