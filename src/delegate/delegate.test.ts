import { afterEach, describe, expect, it, vi } from 'vitest';
import { testConfig, type Config } from '../config';
import { createStore } from '../db/db';
import { createEventBus } from '../domain/events';
import type { BookingService, Router } from '../domain/ports';
import type { Brief, Candidate, HaasEvent } from '../domain/types';
import { createJobService } from '../engine/jobs';
import { fakePaymentService, fakeSeller, type Fake } from '../masumi/__fixtures__/fake-seller';
import { createBuyer } from '../masumi/buyer';
import { createClassifier } from './classify';
import { createDelegator, taskText } from './delegate';

const open: Fake[] = [];
const track = <T extends Fake>(f: T): T => (open.push(f), f);
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

const digital: Brief = { task: 'Summarise the Cardano Chang upgrade in five bullets', skills: [], remoteOk: true };
const physical: Brief = { task: 'Pick up a parcel in Zurich and drop it off at the post office', skills: [], remoteOk: true };

const cand: Candidate = {
  profile: { id: 'fake:a', platform: 'fake', platformId: 'a', url: 'https://x/a', name: 'A', headline: 'h', skills: [], pricing: [], fetchedAt: 1 },
  score: 80,
  subscores: { suitability: 1, price: 1, rating: 1, availability: 1, speed: 1 },
  reason: 'r',
  unknowns: [],
};

function setup(overrides: Partial<Config>) {
  const config = testConfig({ ANTHROPIC_API_KEY: undefined, ...overrides });
  const store = createStore(':memory:');
  const bus = createEventBus();
  const events: HaasEvent[] = [];
  bus.on((e) => events.push(e));
  const route = vi.fn<Router['route']>(async () => ({ candidates: [cand], sources: [] }));
  const bookings = {} as BookingService;
  const delegate = createDelegator({ config, bus, classifier: createClassifier({ config }), buyer: createBuyer(config, { pollMs: 5, maxPollMs: 20 }) });
  const jobs = createJobService({ store, bus, router: { route }, bookings, config, delegate });
  const progress = () => events.flatMap((e) => (e.type === 'job.progress' ? [e.message] : []));
  return { store, jobs, route, progress };
}

const settled = (store: ReturnType<typeof createStore>, id: string, status: string) =>
  vi.waitFor(() => expect(store.getJob(id)?.status).toBe(status), { timeout: 3000 });

describe('AI-first delegation in the job lifecycle', () => {
  it('completes a digital job through a free Masumi agent without touching the router', async () => {
    const seller = track(await fakeSeller({ output: '- bullet one\n- bullet two' }));
    const { store, jobs, route, progress } = setup({ AI_AGENT_URL: seller.url, AI_AGENT_NAME: 'Summariser' });
    const job = jobs.startJob({ brief: digital, client: 'local' });
    await settled(store, job.id, 'completed');
    const done = store.getJob(job.id)!;
    expect(done.path).toBe('ai');
    expect(done.result).toMatchObject({ outcome: 'delivered', path: 'ai', output: '- bullet one\n- bullet two', agent: { name: 'Summariser', jobId: 'sj_1', paid: false } });
    expect(done.result?.summary).toContain('bullet one');
    expect(route).not.toHaveBeenCalled();
    expect(progress()).toContain('Trying an AI agent: Summariser…');
    expect(seller.jobs.get('sj_1')?.input.text).toBe(taskText(digital));
  });

  it('pays a paid agent through the buyer payment service', async () => {
    const seller = track(await fakeSeller({ paid: true, resultHash: 'good' }));
    const pay = track(await fakePaymentService());
    const { store, jobs } = setup({ AI_AGENT_URL: seller.url, MASUMI_API_URL: pay.url, MASUMI_API_KEY: 'k' });
    const job = jobs.startJob({ brief: digital, client: 'local' });
    await settled(store, job.id, 'completed');
    expect(store.getJob(job.id)?.result?.agent).toMatchObject({ paid: true, verified: true });
    expect(pay.log.map((l) => l.path)).toContain('/purchase/');
  });

  it('after a restart mid-hire, goes to the human router instead of hiring a second agent', async () => {
    const seller = track(await fakeSeller());
    const { store, jobs, route } = setup({ AI_AGENT_URL: seller.url });
    // The previous process marked the AI attempt and died before recording its outcome.
    store.insertJob({ id: 'job_r', status: 'running', client: 'local', brief: digital, round: 1, createdAt: 1, updatedAt: 1 });
    store.setKv('job:job_r:ai_tried', '1');
    await jobs.tick();
    await settled(store, 'job_r', 'awaiting_input');
    expect(store.getJob('job_r')?.path).toBe('human');
    expect(route).toHaveBeenCalledTimes(1);
    expect(seller.log.filter((l) => l.path === '/start_job')).toHaveLength(0);
  });

  it('keeps an x402 settlement in an AI result', async () => {
    const seller = track(await fakeSeller({ output: 'done' }));
    const { store, jobs } = setup({ AI_AGENT_URL: seller.url });
    store.insertJob({ id: 'job_x', status: 'running', client: 'x402', brief: digital, round: 1, createdAt: 1, updatedAt: 1, settlement: { network: 'solana:devnet', transaction: 'tx1' } as never });
    await jobs.tick();
    await settled(store, 'job_x', 'completed');
    expect(store.getJob('job_x')?.result).toMatchObject({ path: 'ai', output: 'done', settlement: { transaction: 'tx1' } });
  });

  it('sends human work straight to the router', async () => {
    const seller = track(await fakeSeller());
    const { store, jobs, route } = setup({ AI_AGENT_URL: seller.url });
    const job = jobs.startJob({ brief: physical, client: 'local' });
    await settled(store, job.id, 'awaiting_input');
    expect(store.getJob(job.id)?.path).toBe('human');
    expect(route).toHaveBeenCalledTimes(1);
    expect(seller.log).toHaveLength(0);
  });

  it('falls through to humans when the agent fails', async () => {
    const seller = track(await fakeSeller({ failWith: 'nope' }));
    const { store, jobs, route, progress } = setup({ AI_AGENT_URL: seller.url });
    const job = jobs.startJob({ brief: digital, client: 'local' });
    await settled(store, job.id, 'awaiting_input');
    expect(store.getJob(job.id)?.path).toBe('human');
    expect(route).toHaveBeenCalledTimes(1);
    expect(progress().some((m) => m.includes('finding a human'))).toBe(true);
  });

  it('falls through to humans within the time budget when the agent hangs', async () => {
    const seller = track(await fakeSeller({ hang: true }));
    const { store, jobs, route, progress } = setup({ AI_AGENT_URL: seller.url, AI_TIME_BUDGET_MS: 200 });
    const t = Date.now();
    const job = jobs.startJob({ brief: digital, client: 'local' });
    await settled(store, job.id, 'awaiting_input');
    expect(Date.now() - t).toBeLessThan(1500);
    expect(route).toHaveBeenCalledTimes(1);
    expect(progress()).toContain('The AI agent ran out of time; finding a human instead…');
  });

  it('skips the AI step when no agent is configured, and AI_DELEGATION=ai forces the attempt', async () => {
    const none = setup({});
    const j1 = none.jobs.startJob({ brief: digital, client: 'local' });
    await settled(none.store, j1.id, 'awaiting_input');
    expect(none.store.getJob(j1.id)?.path).toBe('human');
    expect(none.progress().some((m) => m.includes('AI agent'))).toBe(false);

    const seller = track(await fakeSeller());
    const forced = setup({ AI_AGENT_URL: seller.url, AI_DELEGATION: 'ai' });
    const j2 = forced.jobs.startJob({ brief: physical, client: 'local' });
    await settled(forced.store, j2.id, 'completed');
    expect(forced.store.getJob(j2.id)?.result?.path).toBe('ai');
  });

  it('records the human path on results of routed jobs', async () => {
    const { store, jobs } = setup({ AI_DELEGATION: 'human' });
    const job = jobs.startJob({ brief: digital, client: 'local' });
    await settled(store, job.id, 'awaiting_input');
    const done = jobs.provideInput(job.id, { action: 'cancel' });
    expect(done.result).toMatchObject({ outcome: 'no_booking', path: 'human' });
  });
});
