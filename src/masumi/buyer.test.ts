import { afterEach, describe, expect, it, vi } from 'vitest';
import { testConfig, type Config } from '../config';
import { fakePaymentService, fakeRegistry, fakeSeller, type Fake } from './__fixtures__/fake-seller';
import { buildInputData, createBuyer, newPurchaserId, schemaFields } from './buyer';
import { inputHash } from './hash';

const open: Fake[] = [];
const track = <T extends Fake>(f: T): T => (open.push(f), f);
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

const fast = { pollMs: 5, maxPollMs: 20 };

describe('helpers', () => {
  it('generates a 20-char hex purchaser id', () => expect(newPurchaserId()).toMatch(/^[0-9a-f]{20}$/));

  it('flattens input_groups and maps the task into the text field', () => {
    const fields = schemaFields({ input_groups: [{ id: 'g', title: 'G', input_data: [{ id: 'prompt', type: 'string', name: 'P' }, { id: 'n', type: 'number', name: 'N', validations: [{ validation: 'min', value: '3' }] }] }] });
    expect(buildInputData(fields, 'hi')).toEqual({ prompt: 'hi', n: 3 });
    expect(buildInputData(fields, 'hi', 'q')).toEqual({ q: 'hi' });
    expect(buildInputData([], 'hi')).toEqual({ text: 'hi' });
  });
});

describe('buyer', () => {
  it('hires a free agent without a purchase and returns its output', async () => {
    const seller = track(await fakeSeller({ runningPolls: 2 }));
    const pay = track(await fakePaymentService());
    const buyer = createBuyer(testConfig({ MASUMI_API_URL: pay.url, MASUMI_API_KEY: 'k' }), fast);
    const progress: string[] = [];
    const r = await buyer.hire({ name: 'Summariser', apiBaseUrl: seller.url, source: 'pinned' }, 'Summarise X', { onProgress: (m) => progress.push(m) });
    expect(r.output).toBe('Done: Summarise X');
    expect(r.work).toMatchObject({ name: 'Summariser', jobId: 'sj_1', paid: false, agentIdentifier: 'agent_abc' });
    expect(r.work.identifierFromPurchaser).toMatch(/^[0-9a-f]{20}$/);
    const job = seller.jobs.get('sj_1')!;
    expect(job.input).toEqual({ text: 'Summarise X', style: [0] });
    expect(pay.log).toHaveLength(0);
    expect(progress.some((m) => m.includes('sj_1'))).toBe(true);
  });

  it('locks funds for a paid agent with the purchase body the payment service expects', async () => {
    const seller = track(await fakeSeller({ paid: true, resultHash: 'good' }));
    const pay = track(await fakePaymentService());
    const buyer = createBuyer(testConfig({ MASUMI_API_URL: pay.url, MASUMI_API_KEY: 'buyer-key', MASUMI_NETWORK: 'Preprod' }), fast);
    const r = await buyer.hire({ name: 'A', apiBaseUrl: seller.url, source: 'pinned' }, 'Translate hello');
    expect(r.work).toMatchObject({ paid: true, verified: true, blockchainIdentifier: 'bc_sj_1' });
    const purchase = pay.log.find((l) => l.path === '/purchase/')!;
    expect(purchase.token).toBe('buyer-key');
    const ifp = r.work.identifierFromPurchaser;
    expect(purchase.body).toEqual({
      identifierFromPurchaser: ifp,
      blockchainIdentifier: 'bc_sj_1',
      network: 'Preprod',
      sellerVkey: 'vkey_seller',
      paymentType: 'Web3CardanoV1',
      submitResultTime: '1700003600000',
      unlockTime: '1700007200000',
      externalDisputeUnlockTime: '1700010800000',
      agentIdentifier: 'agent_abc',
      inputHash: inputHash(seller.jobs.get('sj_1')!.input, ifp),
    });
  });

  it('requests a refund and rejects on a result hash mismatch', async () => {
    const seller = track(await fakeSeller({ paid: true, resultHash: 'bad' }));
    const pay = track(await fakePaymentService());
    const buyer = createBuyer(testConfig({ MASUMI_API_URL: pay.url, MASUMI_API_KEY: 'k' }), fast);
    await expect(buyer.hire({ name: 'A', apiBaseUrl: seller.url, source: 'pinned' }, 'x')).rejects.toThrow(/hash mismatch/);
    expect(pay.log.find((l) => l.path === '/purchase/request-refund')?.body).toEqual({ blockchainIdentifier: 'bc_sj_1', network: 'Preprod' });
  });

  it('refuses to pay when no buyer key is configured', async () => {
    const seller = track(await fakeSeller({ paid: true }));
    const buyer = createBuyer(testConfig({ MASUMI_API_KEY: undefined }), fast);
    await expect(buyer.hire({ name: 'A', apiBaseUrl: seller.url, source: 'pinned' }, 'x')).rejects.toThrow(/requires payment/);
  });

  it('skips the purchase in forced free mode', async () => {
    const seller = track(await fakeSeller({ paid: true }));
    const pay = track(await fakePaymentService());
    const buyer = createBuyer(testConfig({ MASUMI_API_URL: pay.url, MASUMI_API_KEY: 'k', AI_AGENT_FREE: true }), fast);
    expect((await buyer.hire({ name: 'A', apiBaseUrl: seller.url, source: 'pinned' }, 'x')).work.paid).toBe(false);
    expect(pay.log).toHaveLength(0);
  });

  it('rejects when the agent fails, and stops at the abort signal', async () => {
    const failing = track(await fakeSeller({ failWith: 'model overloaded' }));
    const hanging = track(await fakeSeller({ hang: true }));
    const buyer = createBuyer(testConfig(), fast);
    await expect(buyer.hire({ name: 'A', apiBaseUrl: failing.url, source: 'pinned' }, 'x')).rejects.toThrow(/model overloaded/);
    const t = Date.now();
    await expect(buyer.hire({ name: 'B', apiBaseUrl: hanging.url, source: 'pinned' }, 'x', { signal: AbortSignal.timeout(150) })).rejects.toThrow();
    expect(Date.now() - t).toBeLessThan(1500);
  });

  it('lists the pinned agent first, then allowlisted registry matches', async () => {
    const reg = track(
      await fakeRegistry([
        { name: 'Good', apiBaseUrl: 'http://good/', agentIdentifier: 'id_good', tags: ['research'] },
        { name: 'Other', apiBaseUrl: 'http://other', agentIdentifier: 'id_other', tags: ['research'] },
        { name: 'NoUrl', agentIdentifier: 'id_nourl' },
      ]),
    );
    const config: Partial<Config> = {
      MASUMI_REGISTRY_URL: reg.url,
      MASUMI_REGISTRY_TOKEN: 'rt',
      AI_AGENT_URL: 'http://pinned',
      AI_AGENT_NAME: 'Pinned',
      AI_AGENT_ALLOWLIST: 'id_good',
      AI_AGENT_TAGS: 'research',
    };
    const agents = await createBuyer(testConfig(config)).findAgents();
    expect(agents.map((a) => [a.name, a.apiBaseUrl, a.source])).toEqual([
      ['Pinned', 'http://pinned', 'pinned'],
      ['Good', 'http://good', 'registry'],
    ]);
    expect(reg.log[0]).toMatchObject({ path: '/registry-entry-search/', token: 'rt', body: { network: 'Preprod', filter: { tags: ['research'] } } });
  });

  it('never rejects findAgents when the registry is down', async () => {
    const agents = await createBuyer(testConfig({ MASUMI_REGISTRY_URL: 'http://127.0.0.1:1', AI_AGENT_URL: 'http://p' })).findAgents();
    expect(agents).toHaveLength(1);
  });
});

describe('buyer refunds when it gives up after paying', () => {
  it('asks for a refund when the purchase call is cut off by the time budget', async () => {
    const seller = track(await fakeSeller({ paid: true }));
    const pay = track(await fakePaymentService());
    // The payment service records the purchase, but its answer arrives after the budget ran out.
    const slowPurchase: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).endsWith('/purchase/')) await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
      return res;
    };
    const buyer = createBuyer(testConfig({ MASUMI_API_URL: pay.url, MASUMI_API_KEY: 'k' }), { ...fast, fetch: slowPurchase });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error('AI time budget used up')), 100);
    await expect(buyer.hire({ name: 'A', apiBaseUrl: seller.url, source: 'pinned' }, 'Translate hello', { signal: ctrl.signal })).rejects.toThrow();
    await vi.waitFor(() => expect(pay.log.map((l) => l.path)).toContain('/purchase/request-refund'));
  });

  it('asks for a refund when the caller gave up while the paid agent finished', async () => {
    const seller = track(await fakeSeller({ paid: true, resultHash: 'good' }));
    const pay = track(await fakePaymentService());
    const ctrl = new AbortController();
    // The seller's final status arrives just after the budget ran out.
    const lateStatus: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const text = await res.text();
      if (String(input).includes('/status') && JSON.parse(text).status === 'completed') ctrl.abort(new Error('AI time budget used up'));
      return new Response(text, { status: res.status, headers: res.headers });
    };
    const buyer = createBuyer(testConfig({ MASUMI_API_URL: pay.url, MASUMI_API_KEY: 'k' }), { ...fast, fetch: lateStatus });
    await expect(buyer.hire({ name: 'A', apiBaseUrl: seller.url, source: 'pinned' }, 'Translate hello', { signal: ctrl.signal })).rejects.toThrow();
    await vi.waitFor(() => expect(pay.log.map((l) => l.path)).toContain('/purchase/request-refund'));
  });
});
