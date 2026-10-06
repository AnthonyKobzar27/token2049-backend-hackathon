import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import type { ApprovalGate, Store } from '../domain/ports';
import type { Brief } from '../domain/types';
import { rank } from '../router/match';
import {
  createProlificSource,
  FEE_RATE,
  isMicrotask,
  planStudy,
  poolProfile,
  studyStatus,
  withPlaceholders,
  type RawStudy,
  type RawSubmission,
} from './prolific';

const load = (f: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/${f}`, import.meta.url), 'utf8'));
const draft: RawStudy = load('prolific-study.json');
const subs: RawSubmission[] = load('prolific-submissions.json').results;
const config = testConfig({ PROLIFIC_API_TOKEN: 'ptok' });
const brief: Brief = {
  task: 'Label 200 product photos as damaged or not, need 3 participants for about 10 minutes each',
  notes: 'Task form: https://forms.example.com/label',
  skills: ['data labeling'],
  remoteOk: true,
};

const json = (body: unknown, status = 200) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const flush = () => new Promise((r) => setTimeout(r, 0));

function memKv() {
  const kv = new Map<string, string>();
  return { getKv: (k: string) => kv.get(k) ?? null, setKv: (k: string, v: string) => void kv.set(k, v), getBooking: () => ({ jobId: 'job_1' }) } as unknown as Pick<Store, 'getKv' | 'setKv' | 'getBooking'>;
}

/** A fake Prolific API: one study whose status the test moves along. */
function fakeApi(opts: { eligible?: number | 'fail' } = {}) {
  const state = { status: 'UNPUBLISHED', submissions: [] as RawSubmission[] };
  const calls: { method: string; path: string; body?: unknown; auth?: string }[] = [];
  const fetch = vi.fn(async (url: URL, init: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname.replace('/api/v1', '') + (u.search ? u.search : '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? 'GET', path, body, auth: (init.headers as Record<string, string>).authorization });
    if (path === '/eligibility-count/') return opts.eligible === 'fail' ? json({ error: 'x' }, 500) : json({ count: opts.eligible ?? 41234 });
    if (path === '/studies/' && init.method === 'POST') return json({ ...draft, ...body, id: draft.id, status: 'UNPUBLISHED' });
    if (path === `/studies/${draft.id}/transition/`) {
      if (body?.action === 'PUBLISH') state.status = 'ACTIVE';
      return json(true);
    }
    if (path === `/studies/${draft.id}/`) return json({ ...draft, status: state.status });
    if (path.startsWith('/submissions/?')) return json({ results: state.submissions, _links: { next: { href: null } } });
    if (/^\/submissions\/sub_\d\/transition\/$/.test(path)) return json(true);
    return json({ error: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return { state, calls };
}

function fakeGate(approved: boolean) {
  const requests: Parameters<ApprovalGate['request']>[0][] = [];
  const gate: ApprovalGate = {
    request: vi.fn(async (req) => {
      requests.push(req);
      return { approved };
    }),
    resolve: () => {},
  };
  return { gate, requests };
}

describe('prolific planning', () => {
  it('recognises microtasks and nothing done on site', () => {
    expect(isMicrotask(brief)).toBe(true);
    expect(isMicrotask({ task: 'Run a 5 minute survey of UK cyclists', skills: [], remoteOk: true })).toBe(true);
    expect(isMicrotask({ task: 'Build a React dashboard', skills: ['React'], remoteOk: true })).toBe(false);
    expect(isMicrotask({ task: 'Verify a shop is open in Berlin', skills: [], remoteOk: false })).toBe(false);
  });

  it('prices rewards plus fee from places and minutes in the brief', () => {
    const plan = planStudy(brief, config);
    expect(plan).toMatchObject({ places: 3, minutes: 10, rewardCents: 200, fillDays: 1 });
    expect(plan.totalUsd).toBeCloseTo(3 * 2 * (1 + FEE_RATE), 2);
  });

  it('falls back to defaults and fits places to the budget', () => {
    const plan = planStudy({ task: 'Short survey about coffee', skills: [], remoteOk: true, budgetUsd: 30 }, config);
    expect(plan.minutes).toBe(config.PROLIFIC_DEFAULT_MINUTES);
    expect(plan.totalUsd).toBeLessThanOrEqual(30);
    expect(plan.places).toBe(Math.floor(30 / (2 * (1 + FEE_RATE))));
    // The escrowed price of a plan buys the same plan.
    expect(planStudy(brief, config, planStudy(brief, config).totalUsd).places).toBe(3);
  });

  it('builds one honest pool candidate', () => {
    const p = poolProfile({ ...brief, location: 'United Kingdom' }, planStudy(brief, config), 41234, 9);
    expect(p).toMatchObject({ id: 'prolific:pool', platform: 'prolific', name: 'Prolific participant pool', fetchedAt: 9 });
    expect(p.pricing).toEqual([{ kind: 'fixed', amountUsd: planStudy(brief, config).totalUsd, label: '3 × 10 min, incl. fee', deliveryDays: 1 }]);
    expect(p.headline).toContain('41,234 eligible participants');
    expect(p.description).toContain('location (United Kingdom)');
    // No rating, reviews or hours: the router lists them as unknown rather than guessing.
    expect(p.rating).toBeUndefined();
    expect(p.reviewCount).toBeUndefined();
    const [c] = rank(brief, [p], new Map(), { limit: 5 });
    expect(c!.quoteUsd).toBe(p.pricing[0]!.amountUsd);
    expect(c!.unknowns.join(', ')).toMatch(/rating not published/);
  });

  it('adds Prolific placeholders to the task link', () => {
    expect(withPlaceholders('https://f.example/x?a=1')).toBe('https://f.example/x?a=1&PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}');
  });

  it('maps study states and summarises submissions as the delivery', () => {
    expect(studyStatus({ id: 's', status: 'UNPUBLISHED' }, [])).toEqual({ status: 'placed' });
    expect(studyStatus({ id: 's', status: 'ACTIVE', total_available_places: 3 }, subs.slice(0, 1))).toEqual({ status: 'in_progress' });
    const done = studyStatus({ ...draft, status: 'AWAITING REVIEW' }, subs);
    expect(done.status).toBe('delivered');
    expect(done.deliveryText).toContain('3 of 3 places done (1 approved, 2 awaiting review, 1 returned or timed out, 0 rejected)');
    expect(done.deliveryText).toContain('5f0a00000000000000000001: AWAITING REVIEW, code C0DE1234, 9 min');
    expect(done.deliveryUrls).toEqual(['https://app.prolific.com/researcher/workspaces/studies/66f1c0ffee0000000000abcd', 'https://forms.example.com/label']);
  });
});

describe('prolific source', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is a pool source, off without a token, with its own short timeout', () => {
    expect(createProlificSource({ config: testConfig() }).isEnabled()).toBe(false);
    const src = createProlificSource({ config });
    expect(src.isEnabled()).toBe(true);
    expect(src.kind).toBe('pool');
    expect(src.timeoutMs).toBe(config.PROLIFIC_TIMEOUT_MS);
  });

  it('searches: one candidate for microtasks, none otherwise, pool size best effort', async () => {
    const { calls } = fakeApi();
    const src = createProlificSource({ config });
    const [p] = await src.search(brief, { limit: 5 });
    expect(p!.headline).toContain('41,234 eligible');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/eligibility-count/', auth: 'Token ptok' });
    expect(await src.search({ task: 'Logo design', skills: [], remoteOk: true }, { limit: 5 })).toEqual([]);

    fakeApi({ eligible: 'fail' });
    const [q] = await src.search(brief, { limit: 5 });
    expect(q!.headline).toContain('eligible pool size unknown');
  });

  it('hands off when the brief has no task link', async () => {
    const { calls } = fakeApi();
    const src = createProlificSource({ config });
    const res = await src.book!({ bookingId: 'bk_1', profile: poolProfile(brief, planStudy(brief, config), 1), brief: { ...brief, notes: undefined }, priceUsd: 9 });
    expect(res.kind).toBe('handoff');
    expect(calls).toHaveLength(0);
  });

  it('runs the study lifecycle: draft, approval, publish, delivery, accept', async () => {
    const api = fakeApi();
    const { gate, requests } = fakeGate(true);
    const src = createProlificSource({ config: testConfig({ PROLIFIC_API_TOKEN: 'ptok', PROLIFIC_PROJECT_ID: 'proj_1' }), store: memKv(), gate: () => gate });
    const plan = planStudy(brief, config);

    // book(): a draft only, with manual review so nobody is paid yet.
    const res = await src.book!({ bookingId: 'bk_1', profile: poolProfile(brief, plan, 1), brief, priceUsd: plan.totalUsd });
    expect(res).toEqual({ kind: 'placed', platformRef: draft.id, url: `https://app.prolific.com/researcher/workspaces/studies/${draft.id}` });
    const created = api.calls.find((c) => c.method === 'POST' && c.path === '/studies/')!.body as Record<string, unknown>;
    expect(created).toMatchObject({
      internal_name: 'haas:bk_1',
      prolific_id_option: 'url_parameters',
      reward: 200,
      total_available_places: 3,
      estimated_completion_time: 10,
      project: 'proj_1',
    });
    expect(created).not.toHaveProperty('status', 'ACTIVE');
    expect(String(created.external_study_url)).toMatch(/^https:\/\/forms\.example\.com\/label\?PROLIFIC_PID=/);
    expect((created.completion_codes as { actions: { action: string }[] }[])[0]!.actions).toEqual([{ action: 'MANUALLY_REVIEW' }]);
    expect(api.calls.some((c) => c.path.includes('transition'))).toBe(false);

    // First poll: still a draft, so it asks for a 'pay' approval, then publishes.
    expect(await src.getBookingStatus!(draft.id)).toEqual({ status: 'placed' });
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ action: 'pay', bookingId: 'bk_1', jobId: 'job_1' });
    expect(requests[0]!.detail).toMatch(/submissions\/complete\?cc=[0-9A-F]{8}/);
    expect(api.calls.find((c) => c.path.endsWith('/transition/'))).toMatchObject({ method: 'POST', body: { action: 'PUBLISH' } });

    // Running, then awaiting review: the submissions are the delivery.
    expect(await src.getBookingStatus!(draft.id)).toEqual({ status: 'in_progress' });
    api.state.status = 'AWAITING REVIEW';
    api.state.submissions = subs;
    const st = await src.getBookingStatus!(draft.id);
    expect(st.status).toBe('delivered');
    expect(requests).toHaveLength(1);

    // Accepting approves only the submissions awaiting review.
    await src.acceptDelivery!(draft.id);
    const approvals = api.calls.filter((c) => /^\/submissions\/sub_\d\/transition\/$/.test(c.path));
    expect(approvals.map((c) => c.path)).toEqual(['/submissions/sub_1/transition/', '/submissions/sub_4/transition/']);
    expect(approvals.every((c) => (c.body as { action: string }).action === 'APPROVE')).toBe(true);

    await expect(src.requestRevision!(draft.id, 'again')).rejects.toThrow(/no revisions/);
  });

  it('never publishes when the approval is denied', async () => {
    const api = fakeApi();
    const { gate, requests } = fakeGate(false);
    const src = createProlificSource({ config, store: memKv(), gate: () => gate });
    const plan = planStudy(brief, config);
    await src.book!({ bookingId: 'bk_2', profile: poolProfile(brief, plan, 1), brief, priceUsd: plan.totalUsd });
    await src.getBookingStatus!(draft.id);
    await flush();
    await src.getBookingStatus!(draft.id);
    await flush();
    expect(requests).toHaveLength(1);
    expect(api.calls.some((c) => c.path.endsWith('/transition/'))).toBe(false);
  });

  it('never publishes without an approval gate', async () => {
    const api = fakeApi();
    const src = createProlificSource({ config });
    const plan = planStudy(brief, config);
    await src.book!({ bookingId: 'bk_3', profile: poolProfile(brief, plan, 1), brief, priceUsd: plan.totalUsd });
    expect(await src.getBookingStatus!(draft.id)).toEqual({ status: 'placed' });
    await flush();
    expect(api.calls.some((c) => c.path.endsWith('/transition/'))).toBe(false);
  });
});
