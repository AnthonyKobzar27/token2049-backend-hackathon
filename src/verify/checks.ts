// Deterministic checks on a delivery. Cheap, explainable, and run before any model call.
import type { Brief, DeliveredResult, ExpectedField, VerificationCheck } from '../domain/types';

export interface RuleCheck extends VerificationCheck {
  /** A failed hard check fails the delivery on its own; soft ones only inform the rubric. */
  hard: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 2));
const keyOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** "Booking reference: AB123" lines in free text, keyed by normalised label. */
export function fieldsFromText(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text ?? '').split('\n')) {
    const m = /^\s*[-*•]?\s*([\p{L}][\p{L}\p{N} _/-]{0,40}?)\s*[:=]\s*(.+?)\s*$/u.exec(line);
    if (m && !/^https?$/i.test(m[1]!)) out[keyOf(m[1]!)] ??= m[2]!;
  }
  return out;
}

/** Finds a field in the structured fields first, then in "label: value" lines of the text. */
export function lookupField(d: DeliveredResult, name: string): unknown {
  const k = keyOf(name);
  for (const [key, v] of Object.entries(d.fields ?? {})) if (keyOf(key) === k && v !== null && v !== undefined && v !== '') return v;
  return fieldsFromText(d.text)[k];
}

const TIME = /^([01]?\d|2[0-3])[:.][0-5]\d([:.][0-5]\d)?\s*(am|pm)?$|^(0?[1-9]|1[0-2])\s*(am|pm)$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const REFERENCE = /^(?=.*\d)[A-Z0-9][A-Z0-9\-_/#.]{2,63}$/i;

export const isWebUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

/** Null when the value fits the field, otherwise why not. */
export function formatProblem(field: ExpectedField, value: unknown): string | null {
  const s = String(value).trim();
  if (field.pattern) {
    try {
      if (!new RegExp(field.pattern).test(s)) return `does not match ${field.pattern}`;
    } catch {
      // a broken pattern in the brief is not the freelancer's fault
    }
  }
  switch (field.type ?? 'text') {
    case 'text': return s.length ? null : 'is empty';
    case 'number': return typeof value === 'number' || (s !== '' && Number.isFinite(Number(s.replace(/[, ]/g, '')))) ? null : 'is not a number';
    case 'boolean': return typeof value === 'boolean' || /^(true|false|yes|no)$/i.test(s) ? null : 'is not yes/no';
    case 'date': return /\d/.test(s) && !Number.isNaN(Date.parse(s)) ? null : 'is not a date';
    case 'datetime': return /\d/.test(s) && !Number.isNaN(Date.parse(s)) ? null : 'is not a date and time';
    case 'time': return TIME.test(s) || (/T\d{2}:\d{2}/.test(s) && !Number.isNaN(Date.parse(s))) ? null : 'is not a time';
    case 'url': return isWebUrl(s) ? null : 'is not a web link';
    case 'email': return EMAIL.test(s) ? null : 'is not an email address';
    case 'reference': return REFERENCE.test(s) ? null : 'does not look like a reference number';
  }
  return null;
}

/** Share of the delivery's words that come straight from the brief (0 to 1). */
export function briefOverlap(brief: Brief, text: string): number {
  const got = words(text);
  if (got.size === 0) return 0;
  const src = words(`${brief.task} ${brief.notes ?? ''}`);
  let hit = 0;
  for (const w of got) if (src.has(w)) hit++;
  return hit / got.size;
}

export function ruleChecks(brief: Brief, d: DeliveredResult): RuleCheck[] {
  const checks: RuleCheck[] = [];
  const text = d.text?.trim() ?? '';
  const urls = d.urls ?? [];
  const hasFields = Object.values(d.fields ?? {}).some((v) => v !== null && v !== undefined && v !== '');
  const empty = !text && !urls.length && !hasFields;
  checks.push({ name: 'non_empty', ok: !empty, detail: empty ? 'nothing was delivered' : 'delivery has content', hard: true, by: 'rule' });
  if (empty) return checks;

  if (text) {
    const copy = norm(text) === norm(brief.task) || (briefOverlap(brief, text) >= 0.9 && words(text).size >= 3);
    checks.push({ name: 'not_brief_copy', ok: !copy, detail: copy ? 'the delivery repeats the brief instead of answering it' : 'original content', hard: true, by: 'rule' });
  }

  for (const u of urls) {
    if (!isWebUrl(u)) checks.push({ name: 'url_format', ok: false, detail: `not a web link: ${u.slice(0, 80)}`, hard: true, by: 'rule' });
  }

  for (const f of brief.expectedResult?.fields ?? []) {
    const value = lookupField(d, f.name);
    const required = f.required ?? true;
    if (value === undefined) {
      checks.push({ name: `field:${f.name}`, ok: !required, detail: required ? `required field "${f.name}" is missing` : `optional field "${f.name}" not given`, hard: required, by: 'rule' });
      continue;
    }
    const problem = formatProblem(f, value);
    checks.push({ name: `field:${f.name}`, ok: !problem, detail: problem ? `"${f.name}" ${problem}: ${String(value).slice(0, 60)}` : `"${f.name}" present`, hard: true, by: 'rule' });
  }
  return checks;
}

/**
 * Reachability of the delivered links, each with a short timeout. 404/410 is a hard failure;
 * a timeout or a login wall (401/403) is soft, since slow or private links are common and legitimate.
 */
export async function urlChecks(urls: string[], opts: { timeoutMs: number; fetch?: typeof fetch; max?: number }): Promise<RuleCheck[]> {
  const doFetch = opts.fetch ?? fetch;
  const list = [...new Set(urls)].filter(isWebUrl).slice(0, opts.max ?? 5);
  return Promise.all(
    list.map(async (url): Promise<RuleCheck> => {
      const name = `url_reachable:${url.slice(0, 80)}`;
      const signal = AbortSignal.timeout(opts.timeoutMs);
      try {
        let res = await doFetch(url, { method: 'HEAD', redirect: 'follow', signal });
        if (res.status === 405 || res.status === 501) res = await doFetch(url, { method: 'GET', redirect: 'follow', signal });
        if (res.status === 404 || res.status === 410) return { name, ok: false, detail: `link is dead (HTTP ${res.status})`, hard: true, by: 'rule' };
        if (res.status === 401 || res.status === 403) return { name, ok: true, detail: `reachable, access restricted (HTTP ${res.status})`, hard: false, by: 'rule' };
        if (res.status >= 400) return { name, ok: false, detail: `HTTP ${res.status}`, hard: false, by: 'rule' };
        return { name, ok: true, detail: `reachable (HTTP ${res.status})`, hard: false, by: 'rule' };
      } catch (err) {
        const e = err as Error;
        const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        return { name, ok: false, detail: timedOut ? `no answer within ${opts.timeoutMs} ms` : `unreachable: ${e?.message ?? String(err)}`, hard: false, by: 'rule' };
      }
    }),
  );
}
