import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import type { EventBus } from '../domain/ports';
import { contactMessage } from './browser/contact';
import { heuristicListings } from './browser/extract';
import { SITES } from './browser/sites';
import { createFiverrSource, gigToRaw, toolPayload } from './fiverr';

const bus: EventBus = { emit: vi.fn(), on: () => () => {} };
const brief = { task: 'Find an SAT tutor for 2 hours of math prep', skills: ['SAT tutoring'], remoteOk: true, budgetUsd: 80 };
const fixture = (f: string) => readFileSync(new URL(`./browser/__fixtures__/${f}`, import.meta.url), 'utf8');

// Shape of fiverr-mcp-server 0.1.1's search_gigs result (live sample, trimmed).
const MCP_RESULT = {
  structuredContent: {
    gigs: [
      { title: 'train ambitious students to achieve 800 in sat math', seller_name: 'sridharthogata', seller_level: 'level_two_seller', price: 0.4, rating: 5, reviews_count: 69, url: 'https://www.fiverr.com/sridharthogata/teach-sat-math-and-psat-math-for-grades-8-to-12' },
      { title: 'be your online math tutor', seller_name: 'khancopywriter', seller_level: 'level_two_seller', price: 0.05, rating: 0, reviews_count: 0, url: 'https://www.fiverr.com/khancopywriter/be-your-online-math-tutor' },
      { title: 'duplicate card', seller_name: 'sridharthogata', seller_level: 'level_two_seller', price: 0.4, rating: 5, reviews_count: 69, url: 'https://www.fiverr.com/sridharthogata/teach-sat-math-and-psat-math-for-grades-8-to-12' },
    ],
    query: 'SAT tutoring',
  },
};

describe('fiverr source', () => {
  it('searches through the MCP server and fixes its price scale', async () => {
    const mcp = vi.fn(async () => MCP_RESULT);
    const src = createFiverrSource({ config: testConfig(), bus, mcp, readPerseus: async () => null });
    const out = await src.search(brief, { limit: 10 });
    expect(mcp).toHaveBeenCalledWith('search_gigs', { query: 'SAT tutoring', max_price: 80 }, undefined);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 'fiverr:sridharthogata/teach-sat-math-and-psat-math-for-grades-8-to-12',
      platform: 'fiverr',
      name: 'sridharthogata',
      headline: 'train ambitious students to achieve 800 in sat math',
      pricing: [{ kind: 'fixed', amountUsd: 40 }],
      rating: 5,
      reviewCount: 69,
      level: 'Level 2',
    });
    // No reviews means unrated, not a zero rating.
    expect(out[1]!.rating).toBeUndefined();
  });

  it('falls back to the embedded page data in Chrome when the MCP server fails', async () => {
    const src = createFiverrSource({
      config: testConfig(),
      bus,
      mcp: async () => {
        throw new Error('uvx: command not found');
      },
      readPerseus: async () => ({ currency: 'USD', items: [{ title: 'SAT math', seller_name: 'ana', price_i: 35, buying_review_rating: 4.9, buying_review_rating_count: 12, gig_url: '/ana/sat-math' }] }),
    });
    const [p] = await src.search(brief, { limit: 5 });
    expect(p).toMatchObject({ url: 'https://www.fiverr.com/ana/sat-math', pricing: [{ amountUsd: 35 }], rating: 4.9 });
  });

  it('reports both failures when neither backend answers', async () => {
    const src = createFiverrSource({ config: testConfig(), bus, mcp: async () => ({ structuredContent: { gigs: [], error: 'blocked' } }), readPerseus: async () => null });
    await expect(src.search(brief, { limit: 5 })).rejects.toThrow(/MCP search failed \(blocked\)/);
  });

  it('can be switched off', () => {
    expect(createFiverrSource({ config: testConfig({ FIVERR_SEARCH: 'off' }), bus }).isEnabled()).toBe(false);
  });

  it('unwraps text and wrapped structured MCP results', () => {
    expect(toolPayload({ content: [{ type: 'text', text: '{"gigs":[]}' }] })).toEqual({ gigs: [] });
    expect(toolPayload({ structuredContent: { result: { gigs: [1] } } })).toEqual({ gigs: [1] });
    expect(() => toolPayload({ isError: true, content: [{ type: 'text', text: 'boom' }] })).toThrow(/boom/);
    expect(gigToRaw({ price: 0 }).priceAmount).toBeNull();
  });
});

describe('built-in page parsers (live page text)', () => {
  it('parses PeoplePerHour offers', () => {
    const l = heuristicListings(fixture('peopleperhour-search.txt'), SITES.peopleperhour!);
    expect(l.length).toBeGreaterThan(5);
    for (const x of l) {
      expect(x.url).toMatch(/^https:\/\/www\.peopleperhour\.com\/hourlie\//);
      expect(x.name).toBeTruthy();
    }
    const priced = l.filter((x) => x.priceAmount);
    expect(priced.length).toBeGreaterThan(3);
    expect(priced[0]).toMatchObject({ priceCurrency: '$', priceUnit: 'fixed' });
    expect(l.some((x) => typeof x.rating === 'number' && typeof x.reviewCount === 'number')).toBe(true);
  });

  it('parses Guru freelancers', () => {
    const l = heuristicListings(fixture('guru-search.txt'), SITES.guru!);
    expect(l.length).toBeGreaterThan(5);
    expect(l[0]!.url).toMatch(/^https:\/\/www\.guru\.com\/freelancers\//);
    expect(l.filter((x) => x.priceUnit === 'hourly' && x.priceAmount! > 0).length).toBeGreaterThan(3);
    expect(l.some((x) => x.country)).toBe(true);
  });

  it('returns nothing for sites without a parser', () => {
    expect(heuristicListings('x <https://www.fiverr.com/a/b> y', SITES.fiverr!)).toEqual([]);
  });
});

describe('contact message', () => {
  it('carries the brief, timing and budget, and asks for an offer', () => {
    const m = contactMessage({ ...brief, notes: 'Student is in grade 11', hoursNeeded: 2, when: { date: '2026-10-10', window: { start: '14:00', end: '16:00' }, timezone: 'Asia/Singapore' } }, 79.6);
    expect(m).toContain('Find an SAT tutor');
    expect(m).toContain('Student is in grade 11');
    expect(m).toContain('2026-10-10 14:00-16:00 Asia/Singapore');
    expect(m).toContain('$80');
    expect(m).toMatch(/custom offer/);
  });
});
