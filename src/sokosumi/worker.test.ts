import { describe, expect, it, vi } from 'vitest';
import type { Brief, JobPayment } from '../domain/types';
import { resultHash } from '../masumi/hash';
import type { CreatePaymentInput, PaymentClient, PaymentState } from '../masumi/payments';
import { USDM_PREPROD_UNIT } from '../masumi/pricing';
import { CoreError, createCoreClient, type CoreClient, type SokosumiTask, type TaskEventInput } from './core';
import { createTaskBriefParser, formatShortlist } from './haas';
import { createSokosumiWorker, type WorkerDeps } from './worker';

const MIN = 60_000;
const COWORKER = 'cw_123';
const AGENT = 'a'.repeat(56) + '6861617331';
const ADDRESS = 'addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm';

function kv() {
  const m = new Map<string, string>();
  return { getKv: (k: string) => m.get(k) ?? null, setKv: (k: string, v: string) => void m.set(k, v) };
}

function fakeCore(tasks: SokosumiTask[]) {
  const events: { taskId: string; event: TaskEventInput }[] = [];
  let n = 0;
  const reject: { masumiPayment?: CoreError } = {};
  const core: CoreClient = {
    me: async () => ({ id: COWORKER, capabilities: ['tasks'], archivedAt: null }),
    listReadyTasks: async () => tasks.filter((t) => t.status === 'READY'),
    getTask: async (id) => tasks.find((t) => t.id === id)!,
    postEvent: async (taskId, event) => {
      if (event.masumiPayment && reject.masumiPayment) throw reject.masumiPayment;
      events.push({ taskId, event });
      const t = tasks.find((x) => x.id === taskId);
      if (t && event.status) t.status = event.status;
      return { id: `ev_${++n}`, taskId, status: event.status ?? null };
    },
    receipt: async () => ({ settled: false, onChainState: null, txHash: null }),
  };
  return { core, events, reject };
}

function fakePayments(clock: { t: number }) {
  const state: PaymentState = {
    onChainState: null,
    nextAction: 'None',
    fundsLocked: false,
    resultSubmitted: false,
    resultHash: null,
    withdrawn: false,
    collectionTxHash: null,
    errorType: null,
  };
  const created: CreatePaymentInput[] = [];
  const submitted: string[] = [];
  const payments: PaymentClient = {
    createPayment: vi.fn(async (input: CreatePaymentInput): Promise<JobPayment> => {
      created.push(input);
      const w = { payMin: 0, resultMin: 0, unlockDelayMin: 0, disputeDelayMin: 0, ...input.windows };
      const submitResultTime = clock.t + w.resultMin * MIN;
      const unlockTime = submitResultTime + w.unlockDelayMin * MIN;
      return {
        blockchainIdentifier: 'bcid_' + 'f'.repeat(40),
        agentIdentifier: AGENT,
        sellerVKey: 'b'.repeat(56),
        identifierFromPurchaser: input.identifierFromPurchaser,
        inputHash: input.inputHash,
        payByTime: clock.t + w.payMin * MIN,
        submitResultTime,
        unlockTime,
        externalDisputeUnlockTime: unlockTime + w.disputeDelayMin * MIN,
        amounts: input.amounts,
        paymentSourceType: 'Web3CardanoV2',
        supportedPaymentSourceIndex: 0,
        smartContractAddress: ADDRESS,
      };
    }),
    getPayment: vi.fn(async () => ({ ...state })),
    submitResult: vi.fn(async (_id: string, hash: string) => {
      submitted.push(hash);
      state.resultSubmitted = true;
      state.onChainState = 'ResultSubmitted';
    }),
  };
  return { payments, state, created, submitted };
}

const config: WorkerDeps['config'] = {
  SOKOSUMI_COWORKER_ID: COWORKER,
  SOKOSUMI_ORGANIZATION_ID: undefined,
  SOKOSUMI_POLL_MS: 10_000,
  SOKOSUMI_PAID_TASKS: true,
  SOKOSUMI_PAY_WINDOW_MIN: 20,
  SOKOSUMI_RESULT_WINDOW_MIN: 30,
  SOKOSUMI_UNLOCK_DELAY_MIN: 16,
  SOKOSUMI_DISPUTE_DELAY_MIN: 16,
  MASUMI_NETWORK: 'Preprod',
  MASUMI_AGENT_IDENTIFIER: AGENT,
  MASUMI_SMART_CONTRACT_ADDRESS: undefined,
  MASUMI_PRICE_UNIT: USDM_PREPROD_UNIT,
  MASUMI_PRICE_AMOUNT: '1000000',
  MASUMI_FEE_PERCENT: 0,
  MASUMI_PRICE_MAX_AMOUNT: '25000000',
};

const RESULT = 'HAAS shortlist for: logo\n1. "Ana" \\ the designer';

function setup(opts: { paid?: boolean } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const tasks: SokosumiTask[] = [{ id: 'task_1', name: 'Logo', description: 'Find a logo designer, budget 200 USD', status: 'READY', assigneeId: COWORKER }];
  const c = fakeCore(tasks);
  const p = fakePayments(clock);
  const store = kv();
  const runHaas = vi.fn(async (_b: Brief, _id: string) => ({ result: RESULT }));
  const deps: WorkerDeps = {
    core: c.core,
    store,
    config: { ...config, SOKOSUMI_PAID_TASKS: opts.paid ?? true },
    payments: p.payments,
    toBrief: async (t) => ({ task: t.name, skills: [], remoteOk: true }),
    runHaas,
    now: () => clock.t,
    log: () => {},
  };
  const worker = createSokosumiWorker(deps);
  return { clock, tasks, ...c, ...p, store, deps, worker, runHaas };
}

/** Ticks until the HAAS run has settled and the next step has run. */
async function pass(w: ReturnType<typeof createSokosumiWorker>) {
  await w.tick();
  await w.drain();
  await w.tick();
}

describe('Sokosumi worker', () => {
  it('runs an unpaid Task: RUNNING, HAAS, COMPLETED with the result', async () => {
    const s = setup({ paid: false });
    await pass(s.worker);
    expect(s.events.map((e) => e.event.status)).toEqual(['RUNNING', 'COMPLETED']);
    expect(s.events[1]!.event.comment).toBe(RESULT);
    expect(s.payments.createPayment).not.toHaveBeenCalled();
    expect(s.worker.get('task_1')!.stage).toBe('completed');
    await s.worker.tick();
    expect(s.events).toHaveLength(2);
  });

  it('runs a paid Task end to end and records the collection tx', async () => {
    const s = setup();
    await s.worker.tick();
    // RUNNING, then the masumiPayment event with the signed terms.
    expect(s.events.map((e) => e.event.status ?? 'payment')).toEqual(['RUNNING', 'payment']);
    const mp = s.events[1]!.event.masumiPayment!;
    expect(s.created[0]!.windows).toEqual({ payMin: 20, resultMin: 30, unlockDelayMin: 16, disputeDelayMin: 16 });
    expect(s.created[0]!.amounts).toEqual([{ amount: '1000000', unit: USDM_PREPROD_UNIT }]);
    expect(mp).toMatchObject({
      blockchainIdentifier: 'bcid_' + 'f'.repeat(40),
      agentIdentifier: AGENT,
      sellerVkey: 'b'.repeat(56),
      paymentSourceType: 'Web3CardanoV2',
      supportedPaymentSourceIndex: 0,
      Amounts: [{ amount: '1000000', unit: USDM_PREPROD_UNIT }],
      PaymentSource: { network: 'Preprod', smartContractAddress: ADDRESS, policyId: 'a'.repeat(56) },
    });
    expect(mp.identifierFromPurchaser).toMatch(/^[0-9a-f]{20}$/);
    expect(mp.payByTime).toBe(String(s.clock.t + 20 * MIN));
    expect(mp.unlockTime).toBe(String(s.clock.t + 46 * MIN));
    expect('credits' in s.events[1]!.event).toBe(false);

    // Not funded yet: HAAS does not run.
    await pass(s.worker);
    expect(s.runHaas).not.toHaveBeenCalled();

    s.state.fundsLocked = true;
    s.state.onChainState = 'FundsLocked';
    s.clock.t += 3 * MIN;
    await pass(s.worker);
    expect(s.runHaas).toHaveBeenCalledOnce();
    const rec = s.worker.get('task_1')!;
    expect(s.submitted).toEqual([resultHash(RESULT, rec.identifierFromPurchaser!)]);
    expect(rec.stage).toBe('completed');
    expect(s.events.at(-1)!.event).toEqual({ status: 'COMPLETED', comment: RESULT });

    // Before unlockTime nothing is read; after it, the payment service withdraws and we record the tx.
    await s.worker.tick();
    expect(s.worker.get('task_1')!.collectionTxHash).toBeUndefined();
    s.clock.t = rec.payment!.unlockTime + MIN;
    s.state.withdrawn = true;
    s.state.onChainState = 'Withdrawn';
    s.state.collectionTxHash = 'c'.repeat(64);
    await s.worker.tick();
    const done = s.worker.get('task_1')!;
    expect(done.stage).toBe('collected');
    expect(done.collectionTxHash).toBe('c'.repeat(64));
    expect(s.payments.createPayment).toHaveBeenCalledOnce();
    expect(s.payments.submitResult).toHaveBeenCalledOnce();
  });

  it('resumes after a restart without new terms or a second payment event', async () => {
    const s = setup();
    await s.worker.tick();
    const again = createSokosumiWorker(s.deps);
    s.state.fundsLocked = true;
    await pass(again);
    expect(s.payments.createPayment).toHaveBeenCalledOnce();
    expect(s.events.filter((e) => e.event.masumiPayment)).toHaveLength(1);
    expect(again.get('task_1')!.stage).toBe('completed');
  });

  it('does not post the terms again when the first post went through but its answer was lost', async () => {
    const s = setup();
    const post = s.core.postEvent;
    let lost = true;
    s.core.postEvent = async (id, ev) => {
      const r = await post(id, ev);
      if (ev.masumiPayment && lost) {
        lost = false;
        throw new CoreError('Sokosumi unreachable: socket hang up');
      }
      return r;
    };
    await s.worker.tick();
    expect(s.worker.get('task_1')!.stage).toBe('terms');
    s.state.fundsLocked = true;
    s.state.onChainState = 'FundsLocked';
    await pass(s.worker);
    expect(s.events.filter((e) => e.event.masumiPayment)).toHaveLength(1);
    expect(s.worker.get('task_1')!.stage).toBe('completed');
  });

  it('fails the Task when the escrow is not funded before payByTime', async () => {
    const s = setup();
    await s.worker.tick();
    s.clock.t += 21 * MIN;
    await s.worker.tick();
    expect(s.worker.get('task_1')!.stage).toBe('failed');
    expect(s.events.at(-1)!.event.status).toBe('FAILED');
    expect(s.runHaas).not.toHaveBeenCalled();
  });

  it('fails the Task when Sokosumi rejects the payment', async () => {
    const s = setup();
    s.reject.masumiPayment = new CoreError('POST /v1/tasks/task_1/events -> 422 insufficient_balance', 422, 'insufficient_balance');
    await s.worker.tick();
    expect(s.worker.get('task_1')!.stage).toBe('failed');
    expect(s.worker.get('task_1')!.error).toMatch(/insufficient_balance/);
  });

  it('only takes Tasks of the configured Workspace', async () => {
    const s = setup({ paid: false });
    s.tasks[0]!.organizationId = 'org_event';
    const personal = createSokosumiWorker({ ...s.deps, config: { ...s.deps.config, SOKOSUMI_ORGANIZATION_ID: 'personal' } });
    await personal.tick();
    expect(personal.get('task_1')).toBeNull();
    const event = createSokosumiWorker({ ...s.deps, config: { ...s.deps.config, SOKOSUMI_ORGANIZATION_ID: 'org_event' } });
    await event.tick();
    expect(event.get('task_1')).not.toBeNull();
    await event.drain();
  });

  it('fails paid Tasks when the payment service is not configured', async () => {
    const s = setup();
    const w = createSokosumiWorker({ ...s.deps, payments: undefined });
    await w.tick();
    expect(w.get('task_1')!.stage).toBe('failed');
  });
});

describe('Sokosumi Core client', () => {
  it('uses the coworker key as a Bearer token on the runtime paths', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = url.includes('/events') ? { data: { id: 'ev_1', taskId: 't1', status: 'RUNNING' } } : { data: [{ id: 't1', name: 'n', description: null, status: 'READY', assigneeId: 'cw' }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const core = createCoreClient({ apiUrl: 'https://api.preprod.sokosumi.com/', apiKey: 'coworker_abc', fetch: fetchFn });
    const tasks = await core.listReadyTasks('cw');
    expect(tasks[0]!.id).toBe('t1');
    expect(calls[0]!.url).toBe('https://api.preprod.sokosumi.com/v1/tasks?assigneeId=cw&status=READY&take=20');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer coworker_abc');
    const ev = await core.postEvent('t1', { status: 'RUNNING' });
    expect(ev.id).toBe('ev_1');
    expect(calls[1]!.url).toBe('https://api.preprod.sokosumi.com/v1/tasks/t1/events');
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ status: 'RUNNING' });
  });

  it('reports errors with status and kind, never the key', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ kind: 'grant_required', message: 'bad coworker_abc' }), { status: 403 })) as unknown as typeof fetch;
    const core = createCoreClient({ apiUrl: 'https://x', apiKey: 'coworker_abc', fetch: fetchFn });
    const err = await core.getTask('t1').catch((e: CoreError) => e);
    expect(err).toBeInstanceOf(CoreError);
    expect((err as CoreError).status).toBe(403);
    expect((err as CoreError).kind).toBe('grant_required');
    expect((err as CoreError).message).not.toContain('coworker_abc');
  });

  it('rejects keys that are not coworker runtime keys', () => {
    expect(() => createCoreClient({ apiUrl: 'https://x', apiKey: 'sk_user' })).toThrow(/coworker_/);
  });
});

describe('Task to brief and result', () => {
  it('uses a JSON brief from the description as is', async () => {
    const parse = createTaskBriefParser();
    const brief = await parse({ name: 'x', description: JSON.stringify({ task: 'Photograph a storefront', budget_usd: 80, remote_ok: false }) });
    expect(brief).toMatchObject({ task: 'Photograph a storefront', budgetUsd: 80, remoteOk: false });
  });

  it('reads free text without a model', async () => {
    const brief = await createTaskBriefParser()({ name: 'Logo', description: 'Find a logo designer, budget 200 USD' });
    expect(brief.task).toContain('Logo');
    expect(brief.budgetUsd).toBe(200);
  });

  it('formats an empty shortlist with the JSON twin', () => {
    const text = formatShortlist({ task: 't', skills: [], remoteOk: true }, null);
    expect(text).toContain('No freelancer matched');
    expect(text).toContain('"candidates":[]');
  });
});
