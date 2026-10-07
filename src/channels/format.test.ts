import { describe, expect, it } from 'vitest';
import type { Approval, Booking, Candidate, EscrowRecord, Shortlist } from '../domain/types';
import { approvalRequest, bookingStatusLine, verificationLine, callbackData, candidateCard, chunk, esc, escrowInstructions, escrowTimeoutLine, parseCallback, shortlistHeader } from './format';

const candidate: Candidate = {
  profile: {
    id: 'freelancer:123456789', platform: 'freelancer', platformId: '123456789', url: 'https://x.test/u?a=1&b="2"',
    name: 'Ann <script>', headline: 'Logo & brand', skills: [], country: 'DE', rating: 4.9, reviewCount: 120,
    pricing: [{ kind: 'fixed', amountUsd: 80, deliveryDays: 3 }], fetchedAt: 0,
  },
  score: 87.4, subscores: { suitability: 1, price: 1, rating: 1, availability: null, speed: 1 },
  reason: 'Strong <b>fit</b>', unknowns: ['hours per week'], quoteUsd: 80, pricingIndex: 0,
};

describe('format', () => {
  it('escapes HTML everywhere', () => {
    expect(esc('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    const card = candidateCard(candidate, 0);
    expect(card).not.toContain('<script>');
    expect(card).toContain('Ann &lt;script&gt;');
    expect(card).toContain('Strong &lt;b&gt;fit&lt;/b&gt;');
    expect(card).toContain('href="https://x.test/u?a=1&amp;b=&quot;2&quot;"');
    expect(card).toContain('score 87');
    expect(card).toContain('4.9 (120 reviews)');
    expect(card).toContain('delivery 3 d');
    expect(card).toContain('hours per week');
  });

  it('keeps callback data under 64 bytes and round-trips', () => {
    const cbs = [
      { kind: 'choose', shortlistId: 'sl_k3f9x2a1bq', index: 4 },
      { kind: 'refine', jobId: 'job_k3f9x2a1bq' },
      { kind: 'cancel', jobId: 'job_k3f9x2a1bq' },
      { kind: 'approve', approvalId: 'apr_k3f9x2a1bq' },
      { kind: 'deny', approvalId: 'apr_k3f9x2a1bq' },
      { kind: 'pause', bookingId: 'bkg_k3f9x2a1bq' },
    ] as const;
    for (const cb of cbs) {
      const data = callbackData(cb);
      expect(Buffer.byteLength(data)).toBeLessThan(64);
      expect(parseCallback(data)).toEqual(cb);
    }
    expect(parseCallback('zzz')).toBeNull();
    expect(() => callbackData({ kind: 'refine', jobId: 'x'.repeat(80) })).toThrow();
  });

  it('chunks long text under the limit', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    const parts = chunk(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join('\n')).toBe(text);
    const long = chunk('y'.repeat(10_000));
    expect(long.every((p) => p.length <= 4096)).toBe(true);
    expect(long.join('')).toHaveLength(10_000);
    expect(chunk('short')).toEqual(['short']);
  });

  it('shortlist header lists answering and unavailable sources', () => {
    const sl = { candidates: [candidate], round: 1, sources: [
      { source: 'freelancer', ok: true, count: 5, cached: false, ms: 1 },
      { source: 'fiverr', ok: false, count: 0, cached: false, ms: 1, error: 'x' },
    ] } as Shortlist;
    const h = shortlistHeader(sl);
    expect(h).toContain('Answered: freelancer (5)');
    expect(h).toContain('Unavailable: fiverr');
  });

  it('escrow instructions mention devnet only on devnet', () => {
    const e = { amount: 25.5, currency: 'USDC', address: 'Addr123' } as EscrowRecord;
    expect(escrowInstructions(e, 'https://api.devnet.solana.com')).toContain('switch your wallet to devnet');
    expect(escrowInstructions(e, 'https://api.mainnet-beta.solana.com')).not.toContain('devnet');
    expect(escrowInstructions(e, 'x')).toContain('<code>Addr123</code>');
  });

  it('program escrow instructions: sign in the wallet, refund date; timeout lines', () => {
    const e = { amount: 5, currency: 'USDC', deadline: Date.UTC(2026, 9, 20, 12, 0) } as EscrowRecord;
    const text = escrowInstructions(e, 'x');
    expect(text).toContain('approve the transaction');
    expect(text).toContain('2026-10-20 12:00 UTC');
    expect(text).not.toContain('Address');
    expect(escrowTimeoutLine('deposit_expired', e)).toContain('cancelled');
    expect(escrowTimeoutLine('delivery_expired', { ...e, status: 'refunded', explorerUrl: 'https://explorer.solana.com/tx/s' })).toContain('href="https://explorer.solana.com/tx/s"');
  });

  it('booking status lines', () => {
    const b = { id: 'bk', status: 'handoff', note: 'Click <pay>', url: 'https://p.test' } as Booking;
    const line = bookingStatusLine(b)!;
    expect(line).toContain('Click &lt;pay&gt;');
    expect(line).toContain('https://p.test');
    expect(bookingStatusLine({ ...b, status: 'in_progress' })).toBeNull();
  });

  it('approval request escapes', () => {
    expect(approvalRequest({ action: 'book', summary: '<x>' } as Approval)).toContain('&lt;x&gt;');
  });
});

describe('format: QA', () => {
  const b = { id: 'bk_1', jobId: 'j', profileId: 'p', platform: 'fake', source: 's', status: 'verifying', priceUsd: 10, paused: false, createdAt: 0, updatedAt: 0 } as Booking;
  it('renders a QA outcome with escaped failed checks, and the new booking states', () => {
    const r = { verdict: 'fail' as const, score: 0.234, summary: 'Missing <ref>', checks: [{ name: 'field:ref', ok: false, detail: 'required field "ref" is missing' }, { name: 'ok', ok: true, detail: 'fine' }], resultHash: 'h', deliveryHash: 'd', attempt: 1, ms: 1, at: 1 };
    const line = verificationLine(b, r);
    expect(line).toContain('Quality check failed (score 23/100, attempt 1)');
    expect(line).toContain('Missing &lt;ref&gt;');
    expect(line).toContain('• required field &quot;ref&quot; is missing');
    expect(line).not.toContain('fine');
    expect(verificationLine(b, { ...r, verdict: 'pass', score: 1 })).not.toContain('•');
    expect(bookingStatusLine(b)).toMatch(/Checking the work/);
    expect(bookingStatusLine({ ...b, status: 'rejected' })).toMatch(/refunded/);
  });
});
