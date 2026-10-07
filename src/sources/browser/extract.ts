import type { Config } from '../../config';
import { anthropic, hasLlm } from '../../llm/client';
import type { Brief, FreelancerProfile, Pricing } from '../../domain/types';
import type { SiteDef } from './sites';

// Page text in, FreelancerProfile[] out. One model call; the model only copies what is on the page.

export interface RawListing {
  name: string | null;
  headline: string | null;
  url: string | null;
  priceAmount: number | null;
  /** ISO code or symbol as shown on the page. */
  priceCurrency: string | null;
  priceUnit: 'fixed' | 'hourly' | 'unknown' | null;
  deliveryDays: number | null;
  rating: number | null;
  reviewCount: number | null;
  level: string | null;
  country: string | null;
  languages: string[] | null;
  skills: string[] | null;
  online: boolean | null;
}

/** Injectable for tests: returns the parsed JSON object the model produced. */
export type LlmJson = (req: { model: string; system: string; user: string; schema: Record<string, unknown> }) => Promise<unknown>;

const nullable = (type: string | string[]) => ({ type: [...(Array.isArray(type) ? type : [type]), 'null'] });

const LISTING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['listings'],
  properties: {
    listings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'headline', 'url', 'priceAmount', 'priceCurrency', 'priceUnit', 'deliveryDays', 'rating', 'reviewCount', 'level', 'country', 'languages', 'skills', 'online'],
        properties: {
          name: nullable('string'),
          headline: nullable('string'),
          url: nullable('string'),
          priceAmount: nullable('number'),
          priceCurrency: nullable('string'),
          priceUnit: { enum: ['fixed', 'hourly', 'unknown', null] },
          deliveryDays: nullable('number'),
          rating: nullable('number'),
          reviewCount: nullable('number'),
          level: nullable('string'),
          country: nullable('string'),
          languages: { type: ['array', 'null'], items: { type: 'string' } },
          skills: { type: ['array', 'null'], items: { type: 'string' } },
          online: nullable('boolean'),
        },
      },
    },
  },
} as const;

const SYSTEM = `You extract freelancer listings from the text of a web page that a person is viewing.
Rules:
- Copy only what is written on the page. Never guess, infer or invent. Use null for anything that is not shown.
- One entry per freelancer or gig card, in page order. Skip navigation, ads, category lists and "related" or "recommended" widgets that are not results.
- url: the profile or gig link shown in angle brackets <...> next to the card. Copy it exactly; null if there is none.
- priceAmount is a number (no symbols). priceCurrency is the ISO code if shown, otherwise the symbol as written. priceUnit is "hourly" only when the page says per hour, "fixed" for a one-off or "starting at" price, otherwise "unknown".
- rating is the 0-5 star figure. reviewCount is a plain number ("1k+" -> 1000, "(2.1k)" -> 2100).
- level is the badge or level text exactly as shown (e.g. "Top Rated", "Level 2").
- languages and skills only if listed on the page.`;


async function defaultLlm(config: Config): Promise<LlmJson> {
  const client = anthropic(config);
  return async ({ model, system, user, schema }) => {
    const res = await client.messages.create({
      model,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema } },
    });
    const block = res.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') throw new Error(`extraction returned no text (stop_reason ${res.stop_reason})`);
    if (res.stop_reason === 'max_tokens') throw new Error('extraction output was cut off');
    return JSON.parse(block.text);
  };
}

export async function extractProfiles(
  text: string,
  site: SiteDef,
  brief: Brief,
  config: Config,
  opts: { llm?: LlmJson; now?: number } = {},
): Promise<FreelancerProfile[]> {
  if (!text.trim()) return [];
  let raws: RawListing[];
  if (!opts.llm && !hasLlm(config)) {
    // No model: parse the card layout directly (PeoplePerHour, Guru). Other sites return nothing.
    raws = heuristicListings(text, site);
    if (!raws.length) {
      console.warn(`[browser] ${site.name}: no listings found on the page${site.name === 'peopleperhour' || site.name === 'guru' ? '' : ' (no ANTHROPIC_API_KEY, and this site has no built-in parser)'}`);
    }
  } else {
    try {
      const llm = opts.llm ?? (await defaultLlm(config));
      const user = `Site: ${site.name}\nLayout notes: ${site.hints}\nThe person searched for: ${brief.skills.join(', ') || brief.task}\n\nPage text:\n"""\n${text}\n"""`;
      const json = (await llm({ model: config.MODEL_FAST, system: SYSTEM, user, schema: LISTING_SCHEMA as unknown as Record<string, unknown> })) as { listings?: unknown };
      raws = Array.isArray(json?.listings) ? (json.listings as RawListing[]) : [];
    } catch (err) {
      const fallback = heuristicListings(text, site);
      if (!fallback.length) throw err;
      console.warn(`[browser] ${site.name}: model extraction failed (${err instanceof Error ? err.message : String(err)}); used the built-in parser`);
      raws = fallback;
    }
  }
  const seen = new Set<string>();
  const out: FreelancerProfile[] = [];
  for (const raw of raws) {
    if (!raw || typeof raw !== 'object' || !raw.name?.trim() || !raw.url?.trim()) continue;
    if (!/^https?:\/\//i.test(raw.url) && !raw.url.startsWith('/')) continue;
    const profile = normalise(raw, site, opts.now);
    if (seen.has(profile.id)) continue;
    seen.add(profile.id);
    out.push(profile);
  }
  return out;
}

// ---------------------------------------------------------------- built-in parsers

const LINK = /<(https?:\/\/[^>\s]+)>/g;

const empty = (): RawListing => ({
  name: null, headline: null, url: null, priceAmount: null, priceCurrency: null, priceUnit: null, deliveryDays: null,
  rating: null, reviewCount: null, level: null, country: null, languages: null, skills: null, online: null,
});

const amount = (s: string): number => Number(s.replace(/,/g, ''));

/**
 * Card parsers for sites whose search text has a stable shape, used when no model key is set
 * (or the model call fails). They copy only what the card shows, like the model is told to.
 */
export function heuristicListings(text: string, site: Pick<SiteDef, 'name' | 'profileUrlPattern'>): RawListing[] {
  const hits: { url: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(LINK)) {
    if (site.profileUrlPattern.test(m[1]!)) hits.push({ url: m[1]!, start: m.index!, end: m.index! + m[0].length });
  }
  const seen = new Set<string>();
  const out: RawListing[] = [];
  hits.forEach((h, i) => {
    if (seen.has(h.url)) return;
    seen.add(h.url);
    const after = text.slice(h.end, i + 1 < hits.length ? hits[i + 1]!.start : undefined).replace(LINK, ' ');
    const before = text.slice(i > 0 ? hits[i - 1]!.end : 0, h.start).split('\n').map((l) => l.trim()).filter(Boolean);
    const lines = after.split('\n').map((l) => l.trim()).filter(Boolean);
    const raw = { ...empty(), url: h.url };
    if (site.name === 'peopleperhour') {
      // "<title>" <link> tags… "by V T. 5.0 ( 1152 )" "$20" "delivered in 1 day"
      raw.headline = before.at(-1) ?? null;
      const by = after.match(/\bby\s+(.+?)\.?\s+(\d(?:\.\d)?)\s*\(\s*([\d,]+)\s*\)/);
      if (by) {
        raw.name = by[1]!.trim();
        raw.rating = Number(by[2]);
        raw.reviewCount = amount(by[3]!);
      } else {
        const byOnly = after.match(/\bby\s+([^\n]+?)\.?\s*(?:\n|$)/);
        raw.name = byOnly ? byOnly[1]!.trim() : null;
      }
      const price = after.match(/([$£€])\s?([\d,]+(?:\.\d+)?)(\s*\/\s*hr)?/i);
      if (price) {
        raw.priceAmount = amount(price[2]!);
        raw.priceCurrency = price[1]!;
        raw.priceUnit = price[3] ? 'hourly' : 'fixed';
      }
      const days = after.match(/delivered in\s+(\d+)\s+day/i);
      if (days) raw.deliveryDays = Number(days[1]);
    } else if (site.name === 'guru') {
      // <link> "Name" "City, Region, Country" "Get a Quote" "<headline>" "$8/hr · Starting at $36" "<bio>" "<skills>"
      raw.name = lines[0] ?? null;
      const loc = lines[1] && /,/.test(lines[1]) ? lines[1] : null;
      raw.country = loc ? loc.split(',').at(-1)!.trim() : null;
      const rateIdx = lines.findIndex((l) => /\$[\d,]+(?:\.\d+)?\s*\/\s*hr/i.test(l));
      const rate = rateIdx >= 0 ? lines[rateIdx]!.match(/\$([\d,]+(?:\.\d+)?)\s*\/\s*hr/i) : null;
      if (rate) {
        raw.priceAmount = amount(rate[1]!);
        raw.priceCurrency = '$';
        raw.priceUnit = 'hourly';
      }
      const headline = lines.slice(2, rateIdx >= 0 ? rateIdx : 4).filter((l) => !/^get a quote$/i.test(l));
      raw.headline = headline.at(-1) ?? null;
      const skillLine = rateIdx >= 0 ? lines[rateIdx + 2] : undefined;
      raw.skills = skillLine ? skillLine.split(/\s{2,}|·|,/).map((x) => x.trim()).filter(Boolean).slice(0, 8) : null;
    } else {
      return;
    }
    if (raw.name) out.push(raw);
  });
  return out;
}

// ---------------------------------------------------------------- normalise

/** Approximate USD per unit. Good enough for ranking; the published figure is kept in `original`. */
export const USD_RATES: Record<string, number> = {
  USD: 1, EUR: 1.08, GBP: 1.27, CAD: 0.73, AUD: 0.65, NZD: 0.6, CHF: 1.13, SEK: 0.095, NOK: 0.093, DKK: 0.145,
  PLN: 0.25, CZK: 0.043, INR: 0.012, JPY: 0.0067, CNY: 0.14, SGD: 0.74, HKD: 0.128, AED: 0.272, BRL: 0.18, MXN: 0.055, ZAR: 0.054,
};

const SYMBOLS: Record<string, string> = { $: 'USD', 'US$': 'USD', '£': 'GBP', '€': 'EUR', '₹': 'INR', '¥': 'JPY', 'CA$': 'CAD', 'C$': 'CAD', 'A$': 'AUD', 'AU$': 'AUD', 'S$': 'SGD' };

export function currencyCode(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (SYMBOLS[t]) return SYMBOLS[t];
  const up = t.toUpperCase();
  return USD_RATES[up] !== undefined ? up : undefined;
}

const LANGUAGES: Record<string, string> = {
  english: 'en', german: 'de', deutsch: 'de', french: 'fr', spanish: 'es', italian: 'it', portuguese: 'pt', dutch: 'nl', russian: 'ru',
  polish: 'pl', turkish: 'tr', arabic: 'ar', hindi: 'hi', urdu: 'ur', bengali: 'bn', chinese: 'zh', mandarin: 'zh', japanese: 'ja', korean: 'ko',
  swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi', greek: 'el', hebrew: 'he', ukrainian: 'uk', romanian: 'ro', czech: 'cs', indonesian: 'id', vietnamese: 'vi', thai: 'th',
};

function languageCode(s: string): string | undefined {
  const t = s.trim().toLowerCase().replace(/\s*\(.*\)$/, '');
  if (/^[a-z]{2}$/.test(t)) return t;
  return LANGUAGES[t];
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Absolute URL without fragment; undefined when it cannot be resolved. */
export function absoluteUrl(url: string, origin: string): string | undefined {
  try {
    const u = new URL(url, origin);
    u.hash = '';
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Stable id part from the URL path (tracking query is dropped). */
export function platformIdFromUrl(url: string): string {
  const path = new URL(url).pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  return path || new URL(url).hostname;
}

export function normalise(raw: RawListing, site: Pick<SiteDef, 'platform' | 'origin'>, now: number = Date.now()): FreelancerProfile {
  const url = (raw.url && absoluteUrl(raw.url, site.origin)) || site.origin;
  const platformId = platformIdFromUrl(url);

  const pricing: Pricing[] = [];
  const amount = num(raw.priceAmount);
  const code = currencyCode(raw.priceCurrency);
  if (amount !== undefined && amount > 0 && code && raw.priceUnit && raw.priceUnit !== 'unknown') {
    const p: Pricing = {
      kind: raw.priceUnit,
      amountUsd: Math.round(amount * (USD_RATES[code] ?? 1) * 100) / 100,
    };
    if (code !== 'USD') p.original = { amount, currency: code };
    const days = num(raw.deliveryDays);
    if (days !== undefined && days > 0) p.deliveryDays = days;
    pricing.push(p);
  }

  const rating = num(raw.rating);
  const reviews = num(raw.reviewCount);
  const languages = (raw.languages ?? []).map(languageCode).filter((l): l is string => Boolean(l));

  return {
    id: `${site.platform}:${platformId}`,
    platform: site.platform,
    platformId,
    url,
    name: str(raw.name) ?? platformId,
    headline: str(raw.headline) ?? '',
    skills: (raw.skills ?? []).map((s) => s.trim()).filter(Boolean),
    country: str(raw.country),
    languages: languages.length ? [...new Set(languages)] : undefined,
    availability: typeof raw.online === 'boolean' ? { online: raw.online } : undefined,
    pricing,
    rating: rating !== undefined && rating >= 0 && rating <= 5 ? rating : undefined,
    reviewCount: reviews !== undefined && reviews >= 0 ? Math.round(reviews) : undefined,
    level: str(raw.level),
    fetchedAt: now,
  };
}
