import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../config';
import { createFreelancerSource, normaliseUser, type RawUser } from './freelancer';

const load = (f: string) => JSON.parse(readFileSync(new URL(`./__fixtures__/${f}`, import.meta.url), 'utf8'));
const users: RawUser[] = load('freelancer-directory.json').result.users;

describe('freelancer normaliser', () => {
  const profiles = users.map((u) => normaliseUser(u, 1000));

  it('produces well-formed profiles', () => {
    expect(profiles).toHaveLength(users.length);
    for (const p of profiles) {
      expect(p.platform).toBe('freelancer');
      expect(p.id).toBe(`freelancer:${p.platformId}`);
      expect(p.url).toMatch(/^https:\/\/www\.freelancer\.com\/u\/\w+/);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.skills.length).toBeGreaterThan(0);
      expect(p.fetchedAt).toBe(1000);
      for (const pr of p.pricing) {
        expect(pr.kind).toBe('hourly');
        expect(pr.amountUsd).toBeGreaterThan(0);
      }
      if (p.rating !== undefined) expect(p.rating).toBeGreaterThan(0), expect(p.rating).toBeLessThanOrEqual(5);
    }
  });

  it('takes the hourly rate as USD whatever the account currency', () => {
    const cad = profiles.find((p) => p.platformId === '16396919')!;
    expect(cad.pricing[0]).toEqual({ kind: 'hourly', amountUsd: 65 });
    const usd = profiles.find((p) => p.platformId === '23830177')!;
    expect(usd.pricing[0]).toEqual({ kind: 'hourly', amountUsd: 25 });
  });

  it('maps location, rating and verification', () => {
    const de = profiles.find((p) => p.platformId === '56529999')!;
    expect(de.country).toBe('DE');
    expect(de.city).toBe('Berlin');
    expect(de.reviewCount).toBeGreaterThan(0);
    expect(de.verified === undefined || typeof de.verified === 'boolean').toBe(true);
  });

  it('leaves unknown fields undefined', () => {
    const p = normaliseUser({ id: 7, username: 'x' }, 1);
    expect(p.pricing).toEqual([]);
    expect(p.rating).toBeUndefined();
    expect(p.reviewCount).toBeUndefined();
    expect(p.country).toBeUndefined();
    expect(p.verified).toBeUndefined();
    expect(p.languages).toBeUndefined();
    expect(p.availability).toBeUndefined();
  });

  it('normalises the single-user fixture', () => {
    const p = normaliseUser(load('freelancer-user.json').result, 1);
    expect(p.platformId).toBe('44921792');
    expect(p.country).toBe('DE');
  });
});

describe('freelancer source', () => {
  it('is enabled without a token and handoffs without a sandbox token', async () => {
    const src = createFreelancerSource(testConfig());
    expect(src.isEnabled()).toBe(true);
    const profile = normaliseUser(users[0]!, 1);
    const res = await src.book!({ bookingId: 'b', profile, brief: { task: 't', skills: [], remoteOk: true }, priceUsd: 50 });
    expect(res.kind).toBe('handoff');
    if (res.kind === 'handoff') expect(res.url).toBe(profile.url);
  });
});
