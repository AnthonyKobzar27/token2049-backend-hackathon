// Shared helpers for the API sources: JSON over global fetch, currency, country and language lookups.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: unknown,
  ) {
    super(`HTTP ${status} ${url}`);
  }
}

export type Query = Record<string, string | number | boolean | undefined | (string | number)[]>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  query?: Query;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as application/x-www-form-urlencoded. */
  form?: Query;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function toParams(query: Query): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v));
    else params.append(key, String(value));
  }
  return params;
}

/** One JSON request. Throws HttpError on a non-2xx status. */
export async function requestJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
  const target = new URL(url);
  if (opts.query) for (const [k, v] of toParams(opts.query)) target.searchParams.append(k, v);
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = toParams(opts.form).toString();
  }
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await fetch(target, { method: opts.method ?? 'GET', headers, body, signal });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // keep the raw text
  }
  if (!res.ok) throw new HttpError(res.status, target.origin + target.pathname, parsed);
  return parsed as T;
}

// ------------------------------------------------------------- currency

/** Approximate USD per unit, for the currencies Freelancer.com offers. Used only when the API gives no rate. */
export const USD_PER_UNIT: Record<string, number> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  AUD: 0.65,
  CAD: 0.73,
  NZD: 0.6,
  SGD: 0.74,
  HKD: 0.128,
  INR: 0.012,
  PHP: 0.0175,
  PKR: 0.0036,
  IDR: 0.000062,
  MYR: 0.22,
  ZAR: 0.055,
  NGN: 0.00065,
  BRL: 0.18,
  MXN: 0.054,
  CNY: 0.14,
  JPY: 0.0065,
  SEK: 0.095,
  NOK: 0.093,
  DKK: 0.145,
  CHF: 1.13,
  RUB: 0.011,
  AED: 0.272,
  SAR: 0.267,
  TRY: 0.03,
};

/** Converts to USD using `rate` (USD per unit) when given, else the local table. Undefined when unknown. */
export function toUsd(amount: number, currency: string, rate?: number): number | undefined {
  const r = rate && rate > 0 ? rate : USD_PER_UNIT[currency.toUpperCase()];
  if (r === undefined) return undefined;
  return Math.round(amount * r * 100) / 100;
}

// -------------------------------------------------------------- lookups

let regionNames: Map<string, string> | undefined;

/** English country name (lower case) -> ISO 3166-1 alpha-2, built from the runtime's ICU data. */
function regions(): Map<string, string> {
  if (regionNames) return regionNames;
  regionNames = new Map();
  const dn = new Intl.DisplayNames('en', { type: 'region' });
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      try {
        const name = dn.of(code);
        if (name && name !== code) regionNames.set(name.toLowerCase(), code);
      } catch {
        // not a region
      }
    }
  }
  return regionNames;
}

/** The first country named in free text such as "Berlin, Germany". */
export function findCountry(text: string): { name: string; code: string } | undefined {
  const lower = text.toLowerCase();
  let best: { name: string; code: string } | undefined;
  for (const [name, code] of regions()) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower) && (!best || name.length > best.name.length)) {
      best = { name, code };
    }
  }
  if (best) return { name: best.name.replace(/\b\w/g, (c) => c.toUpperCase()), code: best.code };
  return undefined;
}

let languageNames: Map<string, string> | undefined;

/** Language name in English (lower case) -> ISO 639-1. Undefined when the name is unknown. */
export function languageCode(name: string): string | undefined {
  if (!languageNames) {
    languageNames = new Map([['filipino', 'tl']]);
    const dn = new Intl.DisplayNames('en', { type: 'language' });
    for (let a = 97; a <= 122; a++) {
      for (let b = 97; b <= 122; b++) {
        const code = String.fromCharCode(a, b);
        try {
          const n = dn.of(code);
          if (n && n !== code) languageNames.set(n.toLowerCase(), code);
        } catch {
          // not a language
        }
      }
    }
  }
  const key = name.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(key)) return key;
  return languageNames.get(key);
}

const STOPWORDS = new Set(
  'a an the for to of and or in on at with my our your need needs want make made create get find someone person help please new from by be is are as it its this that'.split(' '),
);

/** Up to `n` distinct content words from free text. */
export function keywords(text: string, n: number): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().match(/[a-z0-9+#.]{3,}/g) ?? []) {
    if (!STOPWORDS.has(w) && !out.includes(w)) out.push(w);
    if (out.length >= n) break;
  }
  return out;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;
