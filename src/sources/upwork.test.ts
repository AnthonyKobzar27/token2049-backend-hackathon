import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import type { Brief } from '../domain/types';
import { createUpworkSource, enrichProfile, normaliseRecord, searchFilter, type RawFullProfile, type RawSearchRecord } from './upwork';

const load = (f: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/${f}`, import.meta.url), 'utf8'));
const records: RawSearchRecord[] = load('upwork-search.json').data.freelancerProfileSearchRecords.edges.map((e: { node: RawSearchRecord }) => e.node);
const full: RawFullProfile = load('upwork-profile.json').data.freelancerProfileByProfileKey;
const brief: Brief = { task: 'Build a React dashboard', skills: ['React', 'TypeScript'], remoteOk: true };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('upwork normaliser', () => {
  const profiles = records.map((r) => normaliseRecord(r, 7));

  it('maps a search record', () => {
    expect(profiles[0]).toMatchObject({
      id: 'upwork:~01a1b2c3d4e5f6a7b8',
      platform: 'upwork',
      url: 'https://www.upwork.com/freelancers/~01a1b2c3d4e5f6a7b8',
      name: 'Ana M.',
      headline: 'Senior React & TypeScript Engineer',
      skills: ['React', 'TypeScript', 'Next.js'],
      country: 'PT',
      city: 'Lisbon',
      pricing: [{ kind: 'hourly', amountUsd: 65 }],
      rating: 4.93,
      level: 'Top Rated',
      fetchedAt: 7,
    });
  });

  it('converts a non-USD rate and keeps the original', () => {
    expect(profiles[1]!.pricing[0]).toEqual({ kind: 'hourly', amountUsd: 43.2, original: { amount: 40, currency: 'EUR' } });
    expect(profiles[1]!.country).toBe('DE');
  });

  it('leaves what Upwork does not return undefined, so the router lists it as unknown', () => {
    const unrated = profiles[1]!;
    expect(unrated.rating).toBeUndefined();
    expect(unrated.reviewCount).toBeUndefined();
    expect(unrated.availability).toBeUndefined();
    expect(unrated.timezone).toBeUndefined();
    const bare = profiles[2]!;
    expect(bare.pricing).toEqual([]);
    expect(bare.country).toBeUndefined();
    expect(bare.level).toBeUndefined();
  });

  it('enriches with Job Success Score, availability, response time and time zone', () => {
    const p = enrichProfile(profiles[0]!, full);
    expect(p.level).toBe('Top Rated, 98% Job Success');
    expect(p.reviewCount).toBe(47);
    expect(p.timezone).toBe('Europe/Lisbon');
    expect(p.availability).toEqual({ hoursPerWeek: 40, responseHours: 12 });
    expect(p.verified).toBe(true);
  });

  it('builds a keyword filter, with a country only for on-site work', () => {
    expect(searchFilter(brief)).toEqual({ userType: 'FREELANCER', keyword: 'React TypeScript' });
    expect(searchFilter({ ...brief, location: 'Berlin, Germany', remoteOk: false })).toMatchObject({ location: { country: 'DE' } });
  });
});

describe('upwork source', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is off without credentials', () => {
    expect(createUpworkSource(testConfig()).isEnabled()).toBe(false);
    expect(createUpworkSource(testConfig({ UPWORK_CLIENT_ID: 'id' })).isEnabled()).toBe(false);
    expect(createUpworkSource(testConfig({ UPWORK_CLIENT_ID: 'id', UPWORK_CLIENT_SECRET: 's' })).isEnabled()).toBe(true);
    expect(createUpworkSource(testConfig({ UPWORK_ACCESS_TOKEN: 't' })).isEnabled()).toBe(true);
  });

  it('declares its own short timeout', () => {
    expect(createUpworkSource(testConfig({ UPWORK_TIMEOUT_MS: 1234 })).timeoutMs).toBe(1234);
  });

  it('gets a client-credentials token once, searches and enriches', async () => {
    const calls: { url: string; body: string; auth?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init: RequestInit) => {
        const body = String(init.body ?? '');
        calls.push({ url: String(url), body, auth: (init.headers as Record<string, string>).authorization });
        if (String(url).includes('oauth2/token')) return json({ access_token: 'tok', expires_in: 86400 });
        const q = JSON.parse(body) as { query: string };
        if (q.query.includes('freelancerProfileSearchRecords')) return json(load('upwork-search.json'));
        if (body.includes('~01a1b2c3d4e5f6a7b8')) return json(load('upwork-profile.json'));
        return json({ errors: [{ message: 'not found' }] });
      }),
    );
    const src = createUpworkSource(testConfig({ UPWORK_CLIENT_ID: 'id', UPWORK_CLIENT_SECRET: 'secret' }));
    const out = await src.search(brief, { limit: 2 });
    expect(out).toHaveLength(2);
    expect(out[0]!.level).toBe('Top Rated, 98% Job Success');
    // The second profile's enrichment failed: it is kept as the search returned it.
    expect(out[1]!.reviewCount).toBeUndefined();
    const tokenCalls = calls.filter((c) => c.url.includes('oauth2/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.body).toContain('grant_type=client_credentials');
    const search = JSON.parse(calls.find((c) => c.body.includes('freelancerProfileSearchRecords'))!.body);
    expect(search.variables).toEqual({ searchFilter: { userType: 'FREELANCER', keyword: 'React TypeScript' }, pagination: { first: 2 } });
    expect(calls.filter((c) => c.url.includes('graphql')).every((c) => c.auth === 'Bearer tok')).toBe(true);

    await src.search(brief, { limit: 1 });
    expect(calls.filter((c) => c.url.includes('oauth2/token'))).toHaveLength(1);
  });

  it('throws on GraphQL errors so the registry falls back to the cache', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: null, errors: [{ message: 'Insufficient scope' }] })));
    const src = createUpworkSource(testConfig({ UPWORK_ACCESS_TOKEN: 't' }));
    await expect(src.search(brief, { limit: 3 })).rejects.toThrow(/Insufficient scope/);
  });

  it('always hands off bookings with a deep link', async () => {
    const src = createUpworkSource(testConfig({ UPWORK_ACCESS_TOKEN: 't' }));
    const profile = normaliseRecord(records[0]!, 1);
    const res = await src.book!({ bookingId: 'b', profile, brief: { ...brief, hoursNeeded: 10 }, priceUsd: 650 });
    expect(res).toMatchObject({ kind: 'handoff', url: 'https://www.upwork.com/freelancers/~01a1b2c3d4e5f6a7b8' });
    expect(res.kind === 'handoff' && res.instructions).toMatch(/about 10 hours within \$650/);
  });
});
