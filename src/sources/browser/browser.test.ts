import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../config';
import type { EventBus } from '../../domain/ports';
import type { HaasEvent } from '../../domain/types';
import { classify, detectChallenge, waitForOperator, type PageLike, type PageSignals } from './challenge';
import { extractProfiles, normalise, type LlmJson, type RawListing } from './extract';
import { paceNavigation } from './cdp';
import { queryFor, SITES } from './sites';
import * as fx from './__fixtures__/challenges';

/** Minimal fake page: derives signals from an HTML string with regexes, no DOM. */
function fakePage(html: string, opts: { clearsAfter?: number } = {}): PageLike & { polls: number; fronted: boolean } {
  let polls = 0;
  const page = {
    polls: 0,
    fronted: false,
    url: () => 'https://www.fiverr.com/search/gigs?query=logo',
    title: async () => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '',
    evaluate: async <R>(): Promise<R> => {
      polls++;
      page.polls = polls;
      if (opts.clearsAfter !== undefined && polls > opts.clearsAfter) return { markers: [], frames: [], text: 'results '.repeat(200) } as R;
      const markers = ['px-captcha', 'challenge-form'].filter((id) => html.includes(`id="${id}"`));
      const frames = [...html.matchAll(/<iframe src="([^"]*)"/g)].map((m) => m[1] ?? '');
      const text = (/<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 1500);
      return { markers, frames, text } satisfies PageSignals as R;
    },
    bringToFront: async () => {
      page.fronted = true;
    },
  };
  return page;
}

const bus = () => {
  const events: HaasEvent[] = [];
  const b: EventBus = { emit: (e) => void events.push(e), on: () => () => {} };
  return { b, events };
};

describe('challenge detection', () => {
  it('flags PerimeterX press and hold', async () => {
    expect(await detectChallenge(fakePage(fx.PX_HOLD))).toMatch(/challenge element|px-captcha/);
  });
  it('flags Cloudflare interstitials', async () => {
    expect(await detectChallenge(fakePage(fx.CF_WAIT))).not.toBeNull();
  });
  it('flags access denied titles', async () => {
    expect(await detectChallenge(fakePage(fx.DENIED))).toMatch(/Access Denied/);
  });
  it('flags a short 403 main document only', async () => {
    expect(await detectChallenge(fakePage(fx.FORBIDDEN), { status: 403 })).toBe('HTTP 403');
    expect(await detectChallenge(fakePage(fx.FORBIDDEN), { status: 200 })).toBeNull();
  });
  it('ignores normal pages, including ones that embed recaptcha or talk about captchas', async () => {
    expect(await detectChallenge(fakePage(fx.NORMAL))).toBeNull();
    expect(await detectChallenge(fakePage(fx.ARTICLE_ABOUT_CAPTCHA))).toBeNull();
  });
  it('treats evaluation errors as no signal', async () => {
    const p = { ...fakePage(fx.NORMAL), evaluate: async () => { throw new Error('Execution context was destroyed'); } };
    expect(await detectChallenge(p as PageLike)).toBeNull();
  });
  it('classify uses title patterns', () => {
    expect(classify({ url: '', title: 'Are you a human?', signals: { markers: [], frames: [], text: '' } })).not.toBeNull();
  });
});

describe('waitForOperator', () => {
  it('emits one attention event, fronts the tab, and returns true once cleared', async () => {
    const page = fakePage(fx.PX_HOLD, { clearsAfter: 2 });
    const { b, events } = bus();
    const ok = await waitForOperator(page, b, 'fiverr', { sleep: async () => {} });
    expect(ok).toBe(true);
    expect(page.fronted).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'operator.attention', source: 'fiverr', url: expect.stringContaining('fiverr.com') });
    expect((events[0] as { message: string }).message).toBe('fiverr is asking for a human check. Please complete it in the Chrome window.');
  });
  it('gives up after the timeout', async () => {
    const page = fakePage(fx.PX_HOLD);
    const { b } = bus();
    expect(await waitForOperator(page, b, 'fiverr', { timeoutMs: 40, pollMs: 10 })).toBe(false);
  });
});

describe('sites', () => {
  it('builds search urls from skills, falling back to task keywords', () => {
    const b = { task: 'I need someone to design a logo for my bakery', skills: [], remoteOk: true };
    expect(queryFor(b)).toBe('design logo bakery');
    expect(SITES.fiverr!.searchUrl({ ...b, skills: ['logo design', 'branding'] })).toBe('https://www.fiverr.com/search/gigs?query=logo%20design%20branding');
    expect(SITES.guru!.searchUrl({ ...b, skills: ['web design'] })).toBe('https://www.guru.com/d/freelancers/skill/web-design/');
    expect(SITES.peopleperhour!.searchUrl({ ...b, skills: ['python'] })).toContain('q=python');
  });
  it('recognises gig and profile urls', () => {
    expect(SITES.fiverr!.profileUrlPattern.test('https://www.fiverr.com/ana_pop/design-a-modern-logo?x=1')).toBe(true);
    expect(SITES.fiverr!.profileUrlPattern.test('https://www.fiverr.com/categories/graphics-design')).toBe(false);
    expect(SITES.guru!.profileUrlPattern.test('https://www.guru.com/freelancers/jane-doe')).toBe(true);
  });
});

describe('normalise', () => {
  const site = { platform: 'fiverr', origin: 'https://www.fiverr.com' };
  it('makes absolute urls, stable ids, USD pricing with original kept', () => {
    const p = normalise(fx.EXAMPLE_RAW, site, 123);
    expect(p.url).toBe('https://www.fiverr.com/ana_pop/design-a-modern-logo?context_referrer=search&pos=3');
    expect(p.id).toBe('fiverr:ana_pop/design-a-modern-logo');
    expect(p.platformId).toBe('ana_pop/design-a-modern-logo');
    expect(p.pricing).toEqual([{ kind: 'fixed', amountUsd: 54, original: { amount: 50, currency: 'EUR' }, deliveryDays: 3 }]);
    expect(p.languages).toEqual(['en', 'ro']);
    expect(p.availability).toEqual({ online: true });
    expect(p.rating).toBe(4.9);
    expect(p.fetchedAt).toBe(123);
  });
  it('same gig with a different tracking query gets the same id', () => {
    const a = normalise({ ...fx.EXAMPLE_RAW, url: 'https://www.fiverr.com/ana_pop/design-a-modern-logo?pos=9' }, site);
    expect(a.id).toBe('fiverr:ana_pop/design-a-modern-logo');
  });
  it('handles missing fields and unknown prices', () => {
    const empty: RawListing = { name: 'X', headline: null, url: 'https://www.guru.com/freelancers/x/', priceAmount: null, priceCurrency: null, priceUnit: null, deliveryDays: null, rating: null, reviewCount: null, level: null, country: null, languages: null, skills: null, online: null };
    const p = normalise(empty, { platform: 'guru', origin: 'https://www.guru.com' });
    expect(p.id).toBe('guru:freelancers/x');
    expect(p.pricing).toEqual([]);
    expect(p.headline).toBe('');
    expect(p.skills).toEqual([]);
    expect(p.rating).toBeUndefined();
    expect(p.availability).toBeUndefined();
    expect(normalise({ ...empty, priceAmount: 20, priceCurrency: '$', priceUnit: 'unknown' }, site).pricing).toEqual([]);
    expect(normalise({ ...empty, priceAmount: 20, priceCurrency: 'ZZZ', priceUnit: 'fixed' }, site).pricing).toEqual([]);
    expect(normalise({ ...empty, priceAmount: 30, priceCurrency: 'usd', priceUnit: 'hourly', rating: 9 }, site)).toMatchObject({ pricing: [{ kind: 'hourly', amountUsd: 30 }], rating: undefined });
  });
});

describe('extractProfiles', () => {
  const config = testConfig({ ANTHROPIC_API_KEY: undefined });
  const brief = { task: 'logo', skills: ['logo design'], remoteOk: true };
  it('returns [] without an API key', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await extractProfiles('some text', SITES.fiverr!, brief, config)).toEqual([]);
  });
  it('uses MODEL_FAST, drops unusable and duplicate listings', async () => {
    const llm = vi.fn<LlmJson>(async () => ({
      listings: [fx.EXAMPLE_RAW, { ...fx.EXAMPLE_RAW, url: '/ana_pop/design-a-modern-logo?pos=2' }, { ...fx.EXAMPLE_RAW, url: null }, { ...fx.EXAMPLE_RAW, name: null, url: '/b/c' }, { ...fx.EXAMPLE_RAW, name: 'Bo', url: '/bo/other-gig' }],
    }));
    const out = await extractProfiles('page text', SITES.fiverr!, brief, config, { llm, now: 1 });
    expect(llm.mock.calls[0]![0].model).toBe(config.MODEL_FAST);
    expect(llm.mock.calls[0]![0].user).toContain('page text');
    expect(out.map((p) => p.id)).toEqual(['fiverr:ana_pop/design-a-modern-logo', 'fiverr:bo/other-gig']);
  });
  it('tolerates a malformed reply shape', async () => {
    expect(await extractProfiles('t', SITES.fiverr!, brief, config, { llm: async () => ({ nope: 1 }) })).toEqual([]);
  });
});

describe('pacing', () => {
  it('spaces consecutive navigations by 2 to 4 seconds', async () => {
    vi.useFakeTimers();
    await paceNavigation(undefined, () => 0.5);
    const t0 = Date.now();
    const p = paceNavigation(undefined, () => 0.5);
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3000);
    vi.useRealTimers();
  });
});
