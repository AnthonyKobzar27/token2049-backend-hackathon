// The paywall needs a facilitator's /supported at first use (it builds the 402 from it), so these
// tests run a local stub facilitator on loopback. No Blockfrost, no chain.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import type { ApiDeps, JobService } from '../domain/ports';
import type { Job } from '../domain/types';
import { jobIdForTx, mountX402 } from './x402';

const PAY_TO = 'addr_test1qp7573my7h0fyj9cd2fwrws5v6ep0e6urpx007pz0pjnmakny46m3vmfawqwv3m48dv2s6eysht6tjfdk48lrzrkmj5qpmyq7l';

const listen = (app: express.Express) => new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

const job = (patch: Partial<Job> = {}): Job => ({ id: 'job_x', status: 'awaiting_input', client: 'x402', brief: { task: 't', skills: [], remoteOk: true }, round: 1, createdAt: 1, updatedAt: 1, ...patch });

function fakeJobs(initial: Job[] = []) {
  const store = new Map(initial.map((j) => [j.id, j]));
  const svc: JobService = {
    startJob: vi.fn(({ brief, client, id }) => { const j = job({ id: id ?? 'job_new', brief, client, status: 'running' }); store.set(j.id, j); return j; }),
    markPaid: vi.fn(),
    getJob: (id) => store.get(id) ?? null,
    getShortlist: () => null,
    provideInput: vi.fn((id) => store.get(id)!),
    tick: async () => {},
  };
  return svc;
}

describe('x402 paywall', () => {
  let facilitator: Server;
  let api: Server;
  const jobs = fakeJobs([job({ id: 'job_wait' }), job({ id: 'job_done', status: 'completed' }), job({ id: 'job_other', client: 'masumi' })]);

  beforeAll(async () => {
    const f = express();
    f.get('/supported', (_req, res) =>
      res.json({
        kinds: [{ x402Version: 2, scheme: 'exact', network: 'cardano:preprod', extra: { l1Confirmations: { minimum: 0, maximum: 20 }, assetTransferMethods: ['default'] } }],
        extensions: [],
        signers: {},
      }),
    );
    facilitator = await listen(f);
    const app = express();
    const config = testConfig({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: urlOf(facilitator), PUBLIC_URL: 'http://haas.test' });
    mountX402(app, { jobs, config, store: {} as never, bus: {} as never } satisfies ApiDeps);
    api = await listen(app);
  });
  afterAll(() => { facilitator.close(); api.close(); });

  const post = (path: string, body: unknown) => fetch(urlOf(api) + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('answers an unpaid request with a 402 and well-formed requirements', async () => {
    const res = await post('/x402/route', { task: 'logo design' });
    expect(res.status).toBe(402);
    const header = res.headers.get('payment-required');
    expect(header).toBeTruthy();
    const required = JSON.parse(Buffer.from(header!, 'base64').toString());
    expect(required.x402Version).toBe(2);
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({ scheme: 'exact', network: 'cardano:preprod', amount: '2000000', asset: 'lovelace', payTo: PAY_TO });
    expect(required.accepts[0].extra.confirmationPolicy.l1Confirmations).toBe(0);
  });

  it('rejects a bad brief before asking for payment', async () => {
    const res = await post('/x402/route', { skills: ['x'] });
    expect(res.status).toBe(400);
  });

  it('serves job status, only for x402 jobs', async () => {
    const ok = await fetch(urlOf(api) + '/x402/jobs/job_wait');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ job_id: 'job_wait', status: 'awaiting_input', candidates: [] });
    expect((await fetch(urlOf(api) + '/x402/jobs/job_other')).status).toBe(404);
    expect((await fetch(urlOf(api) + '/x402/jobs/nope')).status).toBe(404);
  });

  it('maps input to provideInput and answers 409 on the wrong state', async () => {
    expect((await post('/x402/jobs/job_wait/input', { action: 'cancel' })).status).toBe(200);
    expect(jobs.provideInput).toHaveBeenCalledWith('job_wait', { action: 'cancel' });
    expect((await post('/x402/jobs/job_done/input', { action: 'cancel' })).status).toBe(409);
    expect((await post('/x402/jobs/job_wait/input', { action: 'confirm' })).status).toBe(400);
  });

  it('derives a stable job id from the payment tx', () => {
    expect(jobIdForTx('ABCDEF0123456789abcdef')).toBe('job_abcdef012345');
  });
});

describe('x402 disabled', () => {
  it('mounts no paywall without X402_PAY_TO but keeps job routes', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = express();
    mountX402(app, { jobs: fakeJobs([job()]), config: testConfig(), store: {} as never, bus: {} as never });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('x402 disabled'));
    log.mockRestore();
    const s = await listen(app);
    expect((await fetch(urlOf(s) + '/x402/route', { method: 'POST' })).status).toBe(404);
    expect((await fetch(urlOf(s) + '/x402/jobs/job_x')).status).toBe(200);
    s.close();
  });
});
