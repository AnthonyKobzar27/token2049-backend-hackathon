import { describe, expect, it } from 'vitest';
import { createFakeSource, fixtures } from './fake';

describe('fake source', () => {
  it('has varied fixtures with unique ids and deliberate gaps', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(24);
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
    expect(fixtures.some((f) => f.pricing.length === 0)).toBe(true);
    expect(fixtures.some((f) => f.rating === undefined)).toBe(true);
    expect(fixtures.some((f) => f.pricing.some((x) => x.kind === 'hourly'))).toBe(true);
    expect(fixtures.some((f) => f.pricing.some((x) => x.kind === 'fixed'))).toBe(true);
    expect(new Set(fixtures.map((f) => f.country)).size).toBeGreaterThan(10);
  });
  it('is a fixture source without booking', () => {
    const s = createFakeSource();
    expect([s.name, s.platform, s.kind, s.isEnabled(), s.book]).toEqual(['fake', 'fake', 'fixture', true, undefined]);
  });
  it('filters by keyword and respects the limit', async () => {
    const s = createFakeSource();
    const r = await s.search({ task: 'need a logo', skills: ['logo design'], remoteOk: true }, { limit: 10 });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]!.platformId).toBe('logo-mara');
    expect(await s.search({ task: 'zzzz qqqq', skills: [], remoteOk: true }, { limit: 10 })).toEqual([]);
    expect(await s.search({ task: 'translation', skills: [], remoteOk: true }, { limit: 2 })).toHaveLength(2);
  });
});
