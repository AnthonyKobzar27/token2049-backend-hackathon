import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import { createRentAHumanSource, normaliseHuman, type RawHuman } from './rentahuman';

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
