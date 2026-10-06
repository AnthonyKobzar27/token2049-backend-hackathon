import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../config';
import type { Brief } from '../domain/types';
import { resultHash } from '../masumi/hash';
import { formatProblem, lookupField, ruleChecks, urlChecks } from './checks';
import { deliveryHash, resultPayload, verifiedResultHash } from './hash';
import { parseRubric } from './rubric';
import type { RubricJudge } from './rubric';
import { createResultVerifier, pickModel } from './verifier';
import { qaSummaryText, revisionRequestText } from './report';

const brief: Brief = {
  task: 'Book a table for two at Burnt Ends on Friday at 8pm',
  skills: [],
  remoteOk: true,
  expectedResult: {
    fields: [
      { name: 'reference', type: 'reference' },
      { name: 'date', type: 'date' },
      { name: 'time', type: 'time' },
      { name: 'note', required: false },
    ],
    criteria: ['Reservation is for two people'],
  },
};
const good = { text: 'Booked.\nReference: BE-48213\nDate: 2026-10-09\nTime: 20:00', fields: {} };
const passing: RubricJudge = async () => ({ verdict: 'pass', score: 0.9, checks: [{ name: 'party size', ok: true, detail: 'for two' }], summary: 'Table booked as asked.' });
const cfg = (o = {}) => testConfig({ ANTHROPIC_API_KEY: 'k', ...o });

describe('rule checks', () => {
  it('reads fields from structured data and from "label: value" lines', () => {
    expect(lookupField({ fields: { Booking_Reference: 'X1' } }, 'booking reference')).toBe('X1');
    expect(lookupField({ text: '- Time: 8pm' }, 'time')).toBe('8pm');
    expect(lookupField({ text: 'nothing here' }, 'time')).toBeUndefined();
  });

  it('validates formats', () => {
    expect(formatProblem({ name: 'd', type: 'date' }, '2026-10-09')).toBeNull();
    expect(formatProblem({ name: 'd', type: 'date' }, 'friday-ish')).toMatch(/not a date/);
    expect(formatProblem({ name: 't', type: 'time' }, '8pm')).toBeNull();
    expect(formatProblem({ name: 't', type: 'time' }, '20:00')).toBeNull();
    expect(formatProblem({ name: 't', type: 'time' }, 'evening')).toMatch(/not a time/);
    expect(formatProblem({ name: 'r', type: 'reference' }, 'BE-48213')).toBeNull();
    expect(formatProblem({ name: 'r', type: 'reference' }, 'confirmed')).toMatch(/reference/);
    expect(formatProblem({ name: 'u', type: 'url' }, 'ftp://x')).toMatch(/link/);
    expect(formatProblem({ name: 'e', type: 'email' }, 'a@b.co')).toBeNull();
    expect(formatProblem({ name: 'p', pattern: '^\\d{4}$' }, '12a4')).toMatch(/match/);
  });

  it('flags missing required fields, bad formats and a copy of the brief; optional fields are soft', () => {
    const missing = ruleChecks(brief, { text: 'Reference: BE-1\nDate: soon' });
    expect(missing.find((c) => c.name === 'field:time')).toMatchObject({ ok: false, hard: true });
    expect(missing.find((c) => c.name === 'field:date')).toMatchObject({ ok: false });
    expect(missing.find((c) => c.name === 'field:note')).toMatchObject({ ok: true, hard: false });
    const copy = ruleChecks({ ...brief, expectedResult: undefined }, { text: brief.task });
    expect(copy.find((c) => c.name === 'not_brief_copy')?.ok).toBe(false);
    expect(ruleChecks(brief, good).every((c) => c.ok)).toBe(true);
  });

  it('checks links with a timeout: 404 is hard, timeouts and login walls are soft', async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('dead')) return new Response(null, { status: 404 });
      if (u.includes('private')) return new Response(null, { status: 403 });
      if (u.includes('nohead')) return new Response(null, { status: init?.method === 'HEAD' ? 405 : 200 });
      if (u.includes('slow')) return new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('t'), { name: 'TimeoutError' }))));
      return new Response(null, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const out = await urlChecks(['https://ok', 'https://dead', 'https://private', 'https://nohead', 'https://slow'], { timeoutMs: 50, fetch });
    expect(out.map((c) => [c.ok, c.hard])).toEqual([[true, false], [false, true], [true, false], [true, false], [false, false]]);
    expect(out[4]!.detail).toMatch(/50 ms/);
  });
});

describe('result hash', () => {
  it('is the MIP-004 output hash of the canonical delivery, stable across key order and whitespace', () => {
    const a = verifiedResultHash('bk_1', { text: ' hi ', fields: { b: 1, a: 2 } }, 'ifp');
    const b = verifiedResultHash('bk_1', { text: 'hi', urls: [], fields: { a: 2, b: 1 } }, 'ifp');
    expect(a).toBe(b);
    expect(a).toBe(resultHash(resultPayload('bk_1', { text: 'hi', fields: { a: 2, b: 1 } }), 'ifp'));
    expect(verifiedResultHash('bk_2', { text: 'hi' })).not.toBe(verifiedResultHash('bk_1', { text: 'hi' }));
    expect(deliveryHash({ text: 'x' })).toBe(deliveryHash({ text: 'x ', urls: [] }));
    expect(deliveryHash({ text: 'x' })).not.toBe(deliveryHash({ text: 'y' }));
  });
});

describe('result verifier', () => {
  it('passes good work: rules first, then the rubric; carries the hash', async () => {
    const rubric = vi.fn(passing);
    const v = createResultVerifier({ config: cfg(), rubric });
    const r = await v.verify({ bookingId: 'bk_1', brief, delivery: good, priceUsd: 40, attempt: 1 });
    expect(r.verdict).toBe('pass');
    expect(r.score).toBeGreaterThan(0.8);
    expect(r.resultHash).toBe(verifiedResultHash('bk_1', good));
    expect(r.model).toBe('claude-haiku-4-5-20251001');
    expect(r.checks.some((c) => c.by === 'llm' && c.name === 'party size')).toBe(true);
    expect(rubric.mock.calls[0]![0].ruleChecks.length).toBeGreaterThan(0);
  });

  it('fails on hard rule failures without calling the model', async () => {
    const rubric = vi.fn(passing);
    const v = createResultVerifier({ config: cfg(), rubric });
    const r = await v.verify({ bookingId: 'bk_1', brief, delivery: { text: 'Done! Reference: pending' }, priceUsd: 40 });
    expect(r.verdict).toBe('fail');
    expect(r.summary).toMatch(/time.*missing|missing/);
    expect(rubric).not.toHaveBeenCalled();
  });

  it('uses the stronger model above the price threshold', () => {
    const c = cfg({ VERIFY_STRONG_MIN_USD: 100 });
    expect(pickModel(c, 99)).toBe('claude-haiku-4-5-20251001');
    expect(pickModel(c, 100)).toBe('claude-opus-5-5');
  });

  it('times out to needs_human', async () => {
    const hang: RubricJudge = (req) => new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    const v = createResultVerifier({ config: cfg({ VERIFY_TIMEOUT_MS: 600 }), rubric: hang });
    const t = Date.now();
    const r = await v.verify({ bookingId: 'bk_1', brief, delivery: good, priceUsd: 40 });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.verdict).toBe('needs_human');
    expect(r.checks.at(-1)).toMatchObject({ name: 'quality_review', ok: false });
    expect(r.checks.at(-1)!.detail).toMatch(/timed out/);
  });

  it('falls back to needs_human when the model is unavailable or not configured', async () => {
    const broken = createResultVerifier({ config: cfg(), rubric: async () => { throw new Error('529 overloaded'); } });
    const r1 = await broken.verify({ bookingId: 'bk_1', brief, delivery: good, priceUsd: 40 });
    expect(r1).toMatchObject({ verdict: 'needs_human' });
    expect(r1.checks.at(-1)!.detail).toMatch(/overloaded/);
    const nokey = createResultVerifier({ config: testConfig({ ANTHROPIC_API_KEY: undefined }) });
    const r2 = await nokey.verify({ bookingId: 'bk_1', brief, delivery: good, priceUsd: 40 });
    expect(r2.verdict).toBe('needs_human');
    expect(r2.summary).toMatch(/person must confirm/);
  });

  it('asks a person when nothing could be read from the platform', async () => {
    const v = createResultVerifier({ config: cfg(), rubric: passing });
    const r = await v.verify({ bookingId: 'bk_1', brief, delivery: {}, priceUsd: 40 });
    expect(r.verdict).toBe('needs_human');
  });

  it('downgrades a self-contradicting review', async () => {
    const lukewarm: RubricJudge = async () => ({ verdict: 'pass', score: 0.4, checks: [], summary: 's' });
    const r = await createResultVerifier({ config: cfg(), rubric: lukewarm }).verify({ bookingId: 'b', brief, delivery: good, priceUsd: 1 });
    expect(r.verdict).toBe('needs_human');
  });

  it('parses model output defensively', () => {
    expect(parseRubric({ verdict: 'maybe', score: 7, checks: [{ name: 'x', ok: 'yes' }] })).toMatchObject({ verdict: 'needs_human', score: 1, checks: [{ name: 'x', ok: false, by: 'llm' }] });
    expect(parseRubric(null).verdict).toBe('needs_human');
  });

  it('renders plain text summaries', async () => {
    const r = await createResultVerifier({ config: cfg(), rubric: passing }).verify({ bookingId: 'b', brief, delivery: { text: 'Reference: pending' }, priceUsd: 1 });
    expect(qaSummaryText(r)).toMatch(/^QA FAILED \(score \d+\/100, attempt 1\)/);
    expect(qaSummaryText(r)).toContain('[x] field:time');
    expect(revisionRequestText(r)).toContain('- required field "time" is missing');
  });
});
