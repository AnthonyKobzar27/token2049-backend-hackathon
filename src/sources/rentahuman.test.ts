import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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
  it('always hands off bookings', async () => {
    const src = createRentAHumanSource(testConfig());
    expect(src.isEnabled()).toBe(true);
    const profile = normaliseHuman(humans[0]!, 1);
    const res = await src.book!({ bookingId: 'b', profile, brief: { task: 't', skills: [], remoteOk: true }, priceUsd: 50 });
    expect(res).toMatchObject({ kind: 'handoff', url: profile.url });
    expect(src.sendMessage).toBeUndefined();
  });
});
