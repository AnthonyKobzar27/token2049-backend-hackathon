import { describe, expect, it } from 'vitest';
import type { Approval, Booking, Candidate, EscrowRecord, Job, Shortlist } from '../domain/types';
import { approvalRequest, bookingStatusLine, verificationLine, callbackData, candidateCard, chunk, esc, escrowInstructions, escrowLine, escrowTimeoutLine, hirerApprovalRequest, jobResult, jobsStatus, parseCallback, reputationLine, shortlistHeader } from './format';

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
      { kind: 'skip_note', approvalId: 'apr_k3f9x2a1bq' },
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

  it('approval request escapes and names the job', () => {
    expect(approvalRequest({ action: 'book', summary: '<x>' } as Approval)).toContain('&lt;x&gt;');
    const job = { client: 'masumi', brief: { task: 'Call the clinic' } } as Job;
    expect(approvalRequest({ action: 'book', summary: 's' } as Approval, job)).toContain('Job from masumi: Call the clinic');
  });

  it('hirer approval text: release with the QA verdict, revise, nothing for book', () => {
    const booking = { priceUsd: 25.5, verification: { verdict: 'pass', score: 0.9, summary: 'Looks <good>' } } as Booking;
    const rel = hirerApprovalRequest({ action: 'accept', summary: 's' } as Approval, booking)!;
    expect(rel.text).toContain('Quality check passed (score 90/100): Looks &lt;good&gt;');
    expect(rel.approve).toBe('Pay $25.50');
    expect(rel.deny).toBe('Ask for a fix');
    const rev = hirerApprovalRequest({ action: 'revise', summary: 's', detail: 'QA failed' } as Approval, null)!;
    expect(rev.text).toContain('QA failed');
    expect(rev.approve).toBe('Send fix request');
    expect(hirerApprovalRequest({ action: 'book', summary: 's' } as Approval, booking)).toBeNull();
  });

  it('escrow lines carry amount, payee, result hash and the right transaction link', () => {
    const txs = [
      { kind: 'deposit', signature: 'd', url: 'https://x/tx/dep', at: 1 },
      { kind: 'release', signature: 'r', url: 'https://x/tx/rel', at: 2 },
    ] as const;
    const base = { amount: 25, currency: 'USDC', payer: 'PayerWallet1234567890', payee: 'PayeeWallet1234567890', resultHash: 'abcdef1234567890', explorerUrl: 'https://x/tx/old', txs: [...txs] } as unknown as EscrowRecord;
    expect(escrowLine({ ...base, status: 'funded' })).toBe('Escrow funded with 25 USDC from Paye…7890. <a href="https://x/tx/dep">View transaction</a>'.replace('Paye…7890', 'Paye…7890').replace('from Paye', 'from Paye'));
    const released = escrowLine({ ...base, status: 'released' })!;
    expect(released).toContain('Released 25 USDC to Paye…7890');
    expect(released).toContain('<code>abcdef…567890</code>');
    expect(released).toContain('href="https://x/tx/rel"');
    const refunded = escrowLine({ ...base, status: 'refunded', txs: [...txs, { kind: 'refund', signature: 'f', url: 'https://x/tx/ref', at: 3 }] })!;
    expect(refunded).toContain('Refunded 25 USDC to Paye…7890');
    expect(refunded).toContain('href="https://x/tx/ref"');
    // Without a per-transaction list the single explorer URL is used.
    expect(escrowLine({ ...base, status: 'released', txs: undefined })).toContain('href="https://x/tx/old"');
    expect(escrowLine({ ...base, status: 'awaiting_deposit' })).toBeNull();
  });

  it('escrow instructions link the pay page and show the solana URL as copyable text', () => {
    const e = { amount: 5, currency: 'USDC', payUrl: 'solana:https://h.test/solana-pay/escrow/bk' } as EscrowRecord;
    const text = escrowInstructions(e, 'x', 'https://h.test/pay/bk');
    expect(text).toContain('<a href="https://h.test/pay/bk">open in your wallet</a>');
    expect(text).toContain('<code>solana:https://h.test/solana-pay/escrow/bk</code>');
    expect(escrowInstructions(e, 'x')).not.toContain('/pay/');
  });

  it('job result leads with the work, shows the hash and the AI agent', () => {
    const human = { status: 'completed', result: { outcome: 'delivered', summary: 'Bounty done by Ann', work: { summary: 'Booked: Thursday 3pm, ref 88213', data: { date: '2026-10-09', time: '15:00' } }, verifiedResult: { hash: 'a'.repeat(64), payload: 'p' }, priceUsd: 3 } } as unknown as Job;
    const text = jobResult(human);
    expect(text.startsWith('<b>Booked: Thursday 3pm, ref 88213</b>')).toBe(true);
    expect(text).toContain('date: 2026-10-09');
    expect(text).toContain(`<code>${'a'.repeat(6)}…${'a'.repeat(6)}</code>`);
    const ai = { status: 'completed', result: { outcome: 'delivered', summary: 'Done by an AI agent', path: 'ai', agent: { name: 'Summariser', paid: true }, output: 'x'.repeat(2000) } } as unknown as Job;
    const aiText = jobResult(ai);
    expect(aiText).toContain('Done by AI agent <b>Summariser</b> (paid through Masumi)');
    expect(aiText).toContain('<blockquote expandable>');
    expect(aiText).toContain('x'.repeat(1500) + '…');
    expect(aiText).not.toContain('x'.repeat(1501));
    expect(jobResult({ status: 'failed', error: 'boom <1>' } as Job)).toBe('Something went wrong: boom &lt;1&gt;');
  });

  it('status list and the in-revision booking line', () => {
    const jobs = [{ status: 'running', brief: { task: 'Translate a deck' } }, { status: 'completed', brief: { task: 'Logo' }, result: { summary: 'Booked Ann' } }] as Job[];
    const text = jobsStatus(jobs);
    expect(text).toContain('Translate a deck</b>\n  in progress');
    expect(text).toContain('completed: Booked Ann');
    expect(jobsStatus([])).toMatch(/Nothing is running/);
    const line = bookingStatusLine({ id: 'bk', status: 'in_revision', note: 'Please add the <tagline>' } as Booking)!;
    expect(line).toContain('asked to fix the work');
    expect(line).toContain('Please add the &lt;tagline&gt;');
  });

  it('reputation line links the receipt and the transaction', () => {
    const explorer = { tx: (h: string) => `https://scan/tx/${h}`, token: (u: string) => `https://scan/token/${u}` };
    const text = reputationLine({ type: 'reputation.recorded', workerId: 'w', bookingId: 'b', jobId: 'j', txHash: 'h1', receiptUnit: 'u1', jobsCompleted: 1 }, explorer, 'Ann <b>');
    expect(text).toContain('Ann &lt;b&gt; now has 1 verified job.');
    expect(text).toContain('href="https://scan/token/u1"');
    expect(text).toContain('href="https://scan/tx/h1"');
    expect(reputationLine({ type: 'reputation.recorded', workerId: 'w', bookingId: 'b', jobId: 'j', txHash: 'h1', jobsCompleted: 2, avgRating: 4.75 }, explorer)).toContain('The worker now has 2 verified jobs, rating 4.8.');
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
    expect(bookingStatusLine({ ...b, status: 'rejected' })).toMatch(/nothing is paid/);
  });
});
