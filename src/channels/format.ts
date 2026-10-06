// Pure formatting for Telegram (HTML parse mode). Every dynamic string goes through esc().

import type { Approval, Booking, Candidate, EscrowRecord, Job, Shortlist, SourceStatus, VerificationReport } from '../domain/types';

export const MAX_MESSAGE = 4096;

export const esc = (s: string | number | undefined | null): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const usd = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

// ------------------------------------------------------- callback data
// Telegram limits callback data to 64 bytes: short tokens, the rest comes from the store.

export type Callback =
  | { kind: 'choose'; shortlistId: string; index: number }
  | { kind: 'refine'; jobId: string }
  | { kind: 'cancel'; jobId: string }
  | { kind: 'approve'; approvalId: string }
  | { kind: 'deny'; approvalId: string }
  | { kind: 'pause'; bookingId: string };

export function callbackData(cb: Callback): string {
  const data = (() => {
    switch (cb.kind) {
      case 'choose': return `c:${cb.shortlistId}:${cb.index}`;
      case 'refine': return `r:${cb.jobId}`;
      case 'cancel': return `x:${cb.jobId}`;
      case 'approve': return `a:${cb.approvalId}`;
      case 'deny': return `d:${cb.approvalId}`;
      case 'pause': return `p:${cb.bookingId}`;
    }
  })();
  if (Buffer.byteLength(data) > 64) throw new Error(`callback data too long: ${data}`);
  return data;
}

export function parseCallback(data: string): Callback | null {
  const [k, a, b] = data.split(':');
  if (!k || !a) return null;
  switch (k) {
    case 'c': {
      const index = Number(b);
      return b !== undefined && Number.isInteger(index) && index >= 0 ? { kind: 'choose', shortlistId: a, index } : null;
    }
    case 'r': return { kind: 'refine', jobId: a };
    case 'x': return { kind: 'cancel', jobId: a };
    case 'a': return { kind: 'approve', approvalId: a };
    case 'd': return { kind: 'deny', approvalId: a };
    case 'p': return { kind: 'pause', bookingId: a };
    default: return null;
  }
}

// ----------------------------------------------------------- messages

export function candidateCard(c: Candidate, index: number): string {
  const p = c.profile;
  const lines: string[] = [];
  const badge = c.identity?.verified ? ` · ✓ verified (${c.identity.by.join(' + ')})` : '';
  lines.push(`<b>${index + 1}. ${esc(p.name)}</b> · ${esc(p.platform)} · score ${Math.round(c.score)}${badge}`);
  if (p.headline) lines.push(esc(p.headline));
  const facts: string[] = [];
  if (c.quoteUsd !== undefined) facts.push(`quote ${usd(c.quoteUsd)}`);
  if (p.rating !== undefined) facts.push(`rating ${p.rating.toFixed(1)}${p.reviewCount !== undefined ? ` (${p.reviewCount} reviews)` : ''}`);
  const days = c.pricingIndex !== undefined ? p.pricing[c.pricingIndex]?.deliveryDays : p.pricing[0]?.deliveryDays;
  if (days !== undefined) facts.push(`delivery ${days} d`);
  if (p.country) facts.push(esc(p.country));
  if (facts.length) lines.push(facts.join(' · '));
  if (c.reason) lines.push(`<i>${esc(c.reason)}</i>`);
  if (c.unknowns.length) lines.push(`Not published: ${esc(c.unknowns.join(', '))}`);
  if (p.url) lines.push(`<a href="${esc(p.url)}">View profile</a>`);
  return lines.join('\n');
}

export function sourcesLine(sources: SourceStatus[]): string {
  const ok = sources.filter((s) => s.ok).map((s) => `${s.source} (${s.count})`);
  const bad = sources.filter((s) => !s.ok).map((s) => s.source);
  const parts: string[] = [];
  if (ok.length) parts.push(`Answered: ${esc(ok.join(', '))}`);
  if (bad.length) parts.push(`Unavailable: ${esc(bad.join(', '))}`);
  return parts.join('. ');
}

export function shortlistHeader(shortlist: Shortlist): string {
  const n = shortlist.candidates.length;
  const head = n === 0
    ? 'I found nobody who fits yet.'
    : `<b>${n} candidate${n === 1 ? '' : 's'}</b>${shortlist.round > 1 ? ` (round ${shortlist.round})` : ''}. Pick one, or ask for different options.`;
  const src = sourcesLine(shortlist.sources);
  return src ? `${head}\n${src}` : head;
}

export const emptyShortlistText = (shortlist: Shortlist): string =>
  `${shortlistHeader(shortlist)}\nTell me what to change (budget, deadline, skills, location) and I will search again.`;

export function jobResult(job: Job): string {
  if (job.status === 'failed') return `Something went wrong: ${esc(job.error ?? 'unknown error')}`;
  const r = job.result;
  if (!r) return 'Done.';
  const lines = [esc(r.summary)];
  if (r.freelancer) lines.push(`Freelancer: <b>${esc(r.freelancer.name)}</b> (${esc(r.freelancer.platform)})`);
  if (r.priceUsd !== undefined) lines.push(`Price: ${usd(r.priceUsd)}`);
  if (r.bookingUrl) lines.push(`<a href="${esc(r.bookingUrl)}">Open booking</a>`);
  return lines.join('\n');
}

const STATUS_TEXT: Partial<Record<Booking['status'], string>> = {
  pending_escrow: 'Waiting for your deposit into escrow.',
  awaiting_approval: 'Deposit received. Waiting for the operator to approve the booking.',
  placed: 'Booked. The freelancer has the order.',
  handoff: 'One step needs you to finish on the platform.',
  delivered: 'The freelancer delivered. Review it; the operator will accept or ask for a revision.',
  verifying: 'The freelancer delivered. Checking the work before any payment is released.',
  verified: 'The work passed the quality check. Waiting for the release approval.',
  rejected: 'The work failed the quality check twice. Nothing is paid; your deposit is being refunded.',
  completed: 'Completed. The escrowed budget is being released.',
  cancelled: 'The booking was cancelled.',
  refunded: 'The booking was cancelled and your deposit is being refunded.',
};

/** One line for a meaningful booking change, or null when nothing is worth saying. */
export function bookingStatusLine(b: Booking): string | null {
  const text = STATUS_TEXT[b.status];
  if (!text) return null;
  const lines = [`<b>Booking ${esc(b.id)}</b>: ${text}`];
  if (b.status === 'handoff' && b.note) lines.push(esc(b.note));
  if ((b.status === 'handoff' || b.status === 'placed') && b.url) lines.push(`<a href="${esc(b.url)}">Open on the platform</a>`);
  else if (b.status === 'cancelled' && b.note) lines.push(esc(b.note));
  return lines.join('\n');
}

export function escrowInstructions(e: EscrowRecord, solanaRpcUrl: string): string {
  const lines = [`<b>Pay into escrow</b>: ${esc(e.amount)} ${esc(e.currency)}`];
  if (e.address) lines.push(`Address:\n<code>${esc(e.address)}</code>`);
  if (solanaRpcUrl.includes('devnet')) lines.push('This is a test setup: switch your wallet to devnet.');
  if (e.address) lines.push('Scan the QR code with a Solana wallet, or send the amount to the address. I will tell you when it arrives.');
  else {
    // On-chain program escrow: the QR is a Solana Pay transaction request the wallet signs.
    lines.push('Scan the QR code with a Solana wallet and approve the transaction: it locks the amount in the HAAS escrow program. I will tell you when it arrives.');
    if (e.deadline) lines.push(`If the work is not accepted by ${esc(new Date(e.deadline).toISOString().slice(0, 16).replace('T', ' '))} UTC, the money goes back to you.`);
  }
  return lines.join('\n');
}

export function escrowTimeoutLine(kind: 'deposit_expired' | 'delivery_expired', e: EscrowRecord): string {
  if (kind === 'deposit_expired') return 'The escrow deposit did not arrive in time, so I cancelled the booking.';
  const text = 'The delivery was not accepted before the escrow deadline, so the budget was returned to you';
  return e.explorerUrl && e.status === 'refunded' ? `${text}. <a href="${esc(e.explorerUrl)}">View transaction</a>` : `${text}.`;
}

export function escrowLine(e: EscrowRecord): string | null {
  const text = { funded: 'Escrow funded', released: 'Escrow released to the freelancer side', refunded: 'Escrow refunded' }[e.status as string];
  if (!text) return null;
  return e.explorerUrl ? `${text}. <a href="${esc(e.explorerUrl)}">View transaction</a>` : `${text}.`;
}

export function approvalRequest(a: Approval): string {
  const lines = [`<b>Approval needed</b>: ${esc(a.action)}`, esc(a.summary)];
  if (a.detail) lines.push(esc(a.detail));
  if (a.bookingId) lines.push(`Booking: <code>${esc(a.bookingId)}</code>`);
  return lines.join('\n');
}

export function bookingsList(bookings: Booking[]): string {
  if (!bookings.length) return 'No open bookings.';
  return bookings
    .map((b) => `<code>${esc(b.id)}</code> · ${esc(b.status)}${b.paused ? ' · paused' : ''} · ${esc(b.platform)} · ${usd(b.priceUsd)}`)
    .join('\n');
}

const QA_HEAD: Record<VerificationReport['verdict'], string> = {
  pass: 'Quality check passed',
  fail: 'Quality check failed',
  needs_human: 'Quality check needs a person',
};

/** The outcome of one QA run (event 'verification.completed'): verdict, score, summary and the failed checks. */
export function verificationLine(b: Booking, r: VerificationReport): string {
  const lines = [`<b>Booking ${esc(b.id)}</b>: ${QA_HEAD[r.verdict]} (score ${Math.round(r.score * 100)}/100, attempt ${r.attempt}).`, esc(r.summary)];
  const failed = r.checks.filter((c) => !c.ok);
  if (r.verdict !== 'pass') for (const c of failed.slice(0, 5)) lines.push(`• ${esc(c.detail || c.name)}`);
  if (failed.length > 5) lines.push(`… and ${failed.length - 5} more`);
  return lines.join('\n');
}

// ----------------------------------------------------------- chunking

/** Splits text into pieces of at most `max` characters, preferring line breaks. */
export function chunk(text: string, max = MAX_MESSAGE): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  const push = (s: string) => {
    if (cur && cur.length + s.length + 1 > max) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${s}` : s;
  };
  for (const line of text.split('\n')) {
    if (line.length <= max) { push(line); continue; }
    if (cur) { out.push(cur); cur = ''; }
    for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
  }
  if (cur) out.push(cur);
  return out;
}
