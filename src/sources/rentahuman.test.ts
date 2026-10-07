import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import { createRentAHumanSource, MAX_SEARCH_REQUESTS, normaliseHuman, placeOf, searchPlan, skillTerms, type RawHuman } from './rentahuman';

const load = (f: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/${f}`, import.meta.url), 'utf8'));
const humans: RawHuman[] = load('rentahuman-humans.json').humans;

describe('rentahuman normaliser', () => {
  const profiles = humans.map((h) => normaliseHuman(h, 5));

  it('produces well-formed profiles', () => {
    expect(profiles.length).toBeGreaterThan(0);
    for (const p of profiles) {
      expect(p.id).toBe(`rentahuman:${p.platformId}`);
      expect(p.url).toBe(`https://rentahuman.ai/humans/${p.platformId}`);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.pricing.length).toBeLessThanOrEqual(1);
      for (const pr of p.pricing) {
        expect(pr.kind).toBe('hourly');
        expect(pr.amountUsd).toBeGreaterThan(0);
      }
      expect(p.country === undefined || /^[A-Z]{2}$/.test(p.country)).toBe(true);
    }
  });

  it('treats zero reviews as unrated and the default UTC zone as unknown', () => {
    const p = profiles[0]!;
    expect(p.rating).toBeUndefined();
    expect(p.reviewCount).toBe(0);
    expect(p.timezone).toBeUndefined();
  });

  it('maps languages to ISO codes and availability to hours', () => {
    const p = normaliseHuman(load('rentahuman-human.json').human, 5);
    expect(p.languages).toEqual(['tl', 'en']);
    expect(p.availability?.hoursPerWeek).toBe(56);
    expect(p.pricing[0]).toEqual({ kind: 'hourly', amountUsd: 8 });
  });

  it('leaves unknown fields undefined', () => {
    const p = normaliseHuman({ id: 'x' }, 1);
    expect(p.pricing).toEqual([]);
    expect(p.rating).toBeUndefined();
    expect(p.country).toBeUndefined();
    expect(p.languages).toBeUndefined();
  });
});

describe('rentahuman source', () => {
  afterEach(() => vi.unstubAllGlobals());
  const brief = { task: 'Call the clinic and book a physio slot', skills: [], remoteOk: true };

  it('hands off when no API key is set', async () => {
    const src = createRentAHumanSource(testConfig());
    expect(src.isEnabled()).toBe(true);
    const profile = normaliseHuman(humans[0]!, 1);
    const res = await src.book!({ bookingId: 'b', profile, brief, priceUsd: 50 });
    expect(res).toMatchObject({ kind: 'handoff', url: profile.url });
    expect(src.getBookingStatus).toBeUndefined();
  });

  type Call = { url: string; method: string; body?: Record<string, unknown>; headers: Record<string, string> };
  function stubApi(routes: Record<string, (c: Call) => { status?: number; json: unknown }>): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
      const u = new URL(String(input));
      const call: Call = { url: u.pathname, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> };
      calls.push(call);
      const key = `${call.method} ${u.pathname}`;
      const route = Object.entries(routes).find(([k]) => new RegExp(`^${k}$`).test(key));
      if (!route) return new Response(JSON.stringify({ success: false, error: 'not found' }), { status: 404 });
      const r = route[1](call);
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
    });
    return calls;
  }

  it('live: hires the chosen human through escrow checkout, follows it and releases on accept', async () => {
    let escrowStatus = 'funded';
    const calls = stubApi({
      'POST /api/escrow/agent-checkout': () => ({ json: { success: true, escrowId: 'esc_1', status: 'funded' } }),
      'GET /api/escrow/esc_1': () => ({ json: { status: escrowStatus, evidence: [{ text: 'Booked Thursday 3pm, ref 88213' }] } }),
      'POST /api/escrow/esc_1/complete': () => ({ json: { success: true } }),
      'POST /api/escrow/esc_1/release': () => ({ json: { success: true } }),
    });
    const src = createRentAHumanSource(testConfig({ RENTAHUMAN_API_KEY: 'rah_test', RENTAHUMAN_BOOKING: 'live' }));
    const profile = normaliseHuman(humans[0]!, 1);
    const res = await src.book!({ bookingId: 'bk1', profile, brief, priceUsd: 12.4 });
    expect(res).toEqual({ kind: 'placed', platformRef: 'escrow:esc_1', url: profile.url });
    const checkout = calls[0]!;
    expect(checkout.headers['X-API-Key']).toBe('rah_test');
    expect(checkout.body).toMatchObject({ humanId: profile.platformId, price: 12, idempotencyKey: 'haas-bk1' });

    expect(await src.getBookingStatus!('escrow:esc_1')).toMatchObject({ status: 'in_progress' });
    escrowStatus = 'submitted';
    expect(await src.getBookingStatus!('escrow:esc_1')).toMatchObject({ status: 'delivered', deliveryText: 'Booked Thursday 3pm, ref 88213' });

    await src.acceptDelivery!('escrow:esc_1');
    expect(calls.slice(-2).map((c) => c.url)).toEqual(['/api/escrow/esc_1/complete', '/api/escrow/esc_1/release']);
    expect(calls.at(-1)!.body).toEqual({ acknowledgeRelease: true });
  });

  it('live: returns the checkout link as a tracked handoff when the wallet cannot fund it', async () => {
    stubApi({ 'POST /api/escrow/agent-checkout': () => ({ json: { escrowId: 'esc_2', checkoutUrl: 'https://checkout.stripe.com/x', status: 'awaiting_funding' } }) });
    const src = createRentAHumanSource(testConfig({ RENTAHUMAN_API_KEY: 'rah_test' }));
    const res = await src.book!({ bookingId: 'bk2', profile: normaliseHuman(humans[0]!, 1), brief, priceUsd: 20 });
    expect(res).toMatchObject({ kind: 'handoff', url: 'https://checkout.stripe.com/x', platformRef: 'escrow:esc_2' });
  });

  it('live: falls back to a bounty and accepts the chosen human when they apply', async () => {
    const profile = normaliseHuman(humans[0]!, 1);
    let appStatus = 'pending';
    const calls = stubApi({
      'POST /api/bounties': () => ({ json: { id: 'b9', escrowId: 'esc_9', status: 'open' } }),
      'GET /api/bounties/b9': () => ({ json: { id: 'b9', status: 'open', escrowId: 'esc_9' } }),
      'GET /api/bounties/b9/applications': () => ({ json: { applications: [{ id: 'app1', humanId: profile.platformId, status: appStatus }] } }),
      'PATCH /api/bounties/b9/applications/app1': () => {
        appStatus = 'accepted';
        return { json: { success: true } };
      },
    });
    const src = createRentAHumanSource(testConfig({ RENTAHUMAN_API_KEY: 'rah_test' }));
    const res = await src.book!({ bookingId: 'bk3', profile, brief, priceUsd: 3 });
    expect(res).toMatchObject({ kind: 'placed', platformRef: `bounty:b9:${profile.platformId}` });
    expect(calls.find((c) => c.url === '/api/bounties')!.body).toMatchObject({ price: 5, priceType: 'fixed', evidenceTypes: ['text'] });
    expect(await src.getBookingStatus!(`bounty:b9:${profile.platformId}`)).toEqual({ status: 'in_progress' });
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ action: 'accept' });
  });

  it('dry_run: prices a bounty without charging and hands off', async () => {
    const calls = stubApi({ 'POST /api/bounties': () => ({ json: { fundingTotal: 26.5 } }) });
    const src = createRentAHumanSource(testConfig({ RENTAHUMAN_API_KEY: 'rah_test', RENTAHUMAN_BOOKING: 'dry_run' }));
    const res = await src.book!({ bookingId: 'bk4', profile: normaliseHuman(humans[0]!, 1), brief, priceUsd: 25 });
    expect(calls[0]!.body).toMatchObject({ dryRun: true });
    expect(res).toMatchObject({ kind: 'handoff' });
    expect((res as { instructions: string }).instructions).toContain('$26.5');
  });
});

describe('rentahuman search widening', () => {
  afterEach(() => vi.unstubAllGlobals());
  const queue = {
    task: 'Wait in line for the iPhone launch at Apple Store Orchard Road, Singapore, Saturday 7am, 4 hours',
    skills: ['line sitter', 'queue standing', 'errand runner', 'personal assistant errands'],
    location: 'Apple Store Orchard Road, Singapore',
    remoteOk: false,
    budgetUsd: 60,
    hoursNeeded: 4,
  };
  const tutor = { task: 'SAT math tutor', skills: ['SAT math tutor', 'math tutoring'], remoteOk: true, budgetUsd: 100, hoursNeeded: 4 };
  const person = (id: string, city: string, country: string): RawHuman => ({ id, name: id, skills: ['Errands'], location: { city, country }, hourlyRate: 50 });

  /** Stub /api/humans; `answer` gets the query of each call (in order). */
  function stubHumans(answer: (q: Record<string, string>, i: number) => RawHuman[] | number): Record<string, string>[] {
    const seen: Record<string, string>[] = [];
    vi.stubGlobal('fetch', async (input: URL | string) => {
      const q = Object.fromEntries(new URL(String(input)).searchParams);
      seen.push(q);
      const r = answer(q, seen.length - 1);
      if (typeof r === 'number') return new Response('{"success":false}', { status: r });
      return new Response(JSON.stringify({ success: true, humans: r }), { status: 200 });
    });
    return seen;
  }

  it('turns free-text places into a city and country', () => {
    expect(placeOf('Apple Store Orchard Road, Singapore')).toEqual({ city: 'Singapore', country: 'SG' });
    expect(placeOf('Berlin, Germany')).toEqual({ city: 'Berlin', country: 'DE' });
    expect(placeOf('12 Main St, Austin, USA')).toEqual({ city: 'Austin', country: 'US' });
    expect(placeOf('Lisbon')).toEqual({ city: 'Lisbon', country: undefined });
  });

  it('maps brief phrases to the words profiles use, keeping the exact skills first', () => {
    const { exact, wide } = skillTerms(queue);
    expect(exact).toEqual(['line sitter', 'queue standing', 'errand runner', 'personal assistant errands']);
    expect(wide.slice(0, 4)).toEqual(exact);
    expect(wide).toEqual(expect.arrayContaining(['queue', 'errand', 'line standing', 'assistant']));
    // Vague words match unrelated skills ("line" is in "Online").
    expect(wide).not.toContain('line');
    expect(wide).not.toContain('sitter');
    expect(skillTerms(tutor).wide).toEqual(expect.arrayContaining(['math', 'tutor', 'teaching']));
  });

  it('plans on-site searches from exact to wide, cap to no cap, city to country to anywhere', () => {
    const { steps } = searchPlan(queue);
    const exact = 'line sitter,queue standing,errand runner,personal assistant errands';
    const wide = skillTerms(queue).wide.join(',');
    expect(steps).toEqual([
      { skill: exact, city: 'Singapore', maxRate: 15 },
      { skill: wide, city: 'Singapore', maxRate: 15 },
      { skill: wide, city: 'Singapore', maxRate: 30 },
      { skill: wide, city: 'Singapore' },
      { skill: wide, country: 'SG' },
      { city: 'Singapore', maxRate: 30 },
      { city: 'Singapore' },
      { country: 'SG', maxRate: 30 },
      { country: 'SG' },
      { skill: wide },
    ]);
    expect(steps.length).toBeLessThanOrEqual(MAX_SEARCH_REQUESTS);
  });

  it('never drops the skill or adds a place for remote work', () => {
    const { steps } = searchPlan(tutor);
    expect(steps.every((s) => typeof s.skill === 'string' && !('city' in s) && !('country' in s))).toBe(true);
    expect(steps.map((s) => s.maxRate)).toEqual([25, 25, 50, undefined]);
  });

  it('widens step by step until it finds people in the place', async () => {
    const calls = stubHumans((q) => (!q.skill && q.city === 'Singapore' && !q.maxRate ? Array.from({ length: 12 }, (_, i) => person(`sg${i}`, 'Singapore', 'SG')) : []));
    const res = await createRentAHumanSource(testConfig()).search(queue, { limit: 10 });
    expect(res).toHaveLength(10);
    expect(res.every((p) => p.country === 'SG')).toBe(true);
    // Stopped at the first step that found enough: generic city search without a cap (step 7).
    expect(calls).toHaveLength(7);
    expect(calls.at(-1)).toMatchObject({ city: 'Singapore', limit: '24' });
  });

  it('stops as soon as the first step finds enough, deduping across steps', async () => {
    const calls = stubHumans((_q, i) => (i === 0 ? [person('a', 'Singapore', 'SG'), person('a', 'Singapore', 'SG'), person('b', 'Singapore', 'SG')] : []));
    const res = await createRentAHumanSource(testConfig()).search(queue, { limit: 2 });
    expect(calls).toHaveLength(1);
    expect(res.map((p) => p.platformId)).toEqual(['a', 'b']);
  });

  it('keeps earlier, more specific matches first and adds later ones', async () => {
    stubHumans((_q, i) => (i === 0 ? [person('exact', 'Singapore', 'SG')] : i === 3 ? [person('exact', 'Singapore', 'SG'), person('wide', 'Singapore', 'SG')] : []));
    const res = await createRentAHumanSource(testConfig()).search(queue, { limit: 10 });
    expect(res.map((p) => p.platformId)).toEqual(['exact', 'wide']);
  });

  it('prefers people in the place, falling back to others only when nobody local is found', async () => {
    stubHumans(() => [person('ldn', 'London', 'GB')]);
    const far = await createRentAHumanSource(testConfig()).search(queue, { limit: 10 });
    expect(far.map((p) => p.platformId)).toEqual(['ldn']);

    const calls = stubHumans((_q, i) => (i === 1 ? [person('ldn', 'London', 'GB'), person('sg', 'Singapore', 'SG')] : []));
    const near = await createRentAHumanSource(testConfig()).search(queue, { limit: 10 });
    expect(near.map((p) => p.platformId)).toEqual(['sg']);
    expect(calls).toHaveLength(MAX_SEARCH_REQUESTS);
  });

  it('skips a failing step but throws when every step failed and nothing was found', async () => {
    stubHumans((_q, i) => (i === 0 ? 500 : [person('sg', 'Singapore', 'SG')]));
    expect((await createRentAHumanSource(testConfig()).search(queue, { limit: 1 })).map((p) => p.platformId)).toEqual(['sg']);
    stubHumans(() => 503);
    await expect(createRentAHumanSource(testConfig()).search(queue, { limit: 5 })).rejects.toThrow(/HTTP 503/);
  });

  it('stops when the signal is aborted', async () => {
    const ctrl = new AbortController();
    const calls = stubHumans(() => {
      ctrl.abort();
      return [];
    });
    await expect(createRentAHumanSource(testConfig()).search(queue, { limit: 5, signal: ctrl.signal })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});
