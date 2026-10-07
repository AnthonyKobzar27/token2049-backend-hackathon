// Pure formatting for Telegram (HTML parse mode). Every dynamic string goes through esc().

import type { Approval, Booking, Candidate, EscrowRecord, HaasEvent, Job, Shortlist, SourceStatus, VerificationReport } from '../domain/types';

export const MAX_MESSAGE = 4096;

export const esc = (s: string | number | undefined | null): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const usd = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
/** "7xKp…3fQa" for wallets and hashes. */
export const short = (s: string, n = 4): string => (s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const link = (url: string, text: string): string => `<a href="${esc(url)}">${esc(text)}</a>`;

// ------------------------------------------------------- callback data
// Telegram limits callback data to 64 bytes: short tokens, the rest comes from the store.
// Prefixes used here: c r x a d s p. Extensions (worker commands) register their own, e.g. k.

export type Callback =
  | { kind: 'choose'; shortlistId: string; index: number }
  | { kind: 'refine'; jobId: string }
  | { kind: 'cancel'; jobId: string }
  | { kind: 'approve'; approvalId: string }
  | { kind: 'deny'; approvalId: string }
  /** Deny without giving a reason (after the "why?" prompt). */
  | { kind: 'skip_note'; approvalId: string }
  | { kind: 'pause'; bookingId: string };

export function callbackData(cb: Callback): string {
  const data = (() => {
    switch (cb.kind) {
      case 'choose': return `c:${cb.shortlistId}:${cb.index}`;
      case 'refine': return `r:${cb.jobId}`;
      case 'cancel': return `x:${cb.jobId}`;
      case 'approve': return `a:${cb.approvalId}`;
      case 'deny': return `d:${cb.approvalId}`;
      case 'skip_note': return `s:${cb.approvalId}`;
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
    case 's': return { kind: 'skip_note', approvalId: a };
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

/** Long AI output is cut here; the full text stays on the job (/api/jobs/:id). */
const MAX_OUTPUT = 1500;

export function jobResult(job: Job): string {
  if (job.status === 'failed') return `Something went wrong: ${esc(job.error ?? 'unknown error')}`;
  const r = job.result;
  if (!r) return 'Done.';
  const lines: string[] = [];
  // The work itself comes first when there is one ("Booked: Thursday 3pm, ref 88213").
  if (r.work?.summary) {
    lines.push(`<b>${esc(r.work.summary)}</b>`);
    lines.push(esc(r.summary));
  } else lines.push(`<b>Done.</b> ${esc(r.summary)}`);
  if (r.work?.data && Object.keys(r.work.data).length) {
    for (const [k, v] of Object.entries(r.work.data).slice(0, 8)) lines.push(`${esc(k)}: ${esc(typeof v === 'string' ? v : JSON.stringify(v))}`);
  }
  for (const u of r.work?.urls ?? []) lines.push(esc(u));
  if (r.path === 'ai' && r.agent) {
    lines.push(`Done by AI agent <b>${esc(r.agent.name)}</b>${r.agent.paid ? ' (paid through Masumi)' : ''}.`);
    if (r.output) {
      const out = r.output.length > MAX_OUTPUT ? `${r.output.slice(0, MAX_OUTPUT)}…` : r.output;
      lines.push(`<blockquote expandable>${esc(out)}</blockquote>`);
    }
  }
  if (r.freelancer) lines.push(`Freelancer: <b>${esc(r.freelancer.name)}</b> (${esc(r.freelancer.platform)})`);
  if (r.priceUsd !== undefined) lines.push(`Price: ${usd(r.priceUsd)}`);
  if (r.bookingRef) lines.push(`Reference: <code>${esc(r.bookingRef)}</code>`);
  if (r.bookingUrl) lines.push(link(r.bookingUrl, 'Open booking'));
  if (r.verifiedResult?.hash) lines.push(`Verified result hash: <code>${esc(short(r.verifiedResult.hash, 6))}</code>`);
  if (r.settlement?.explorerUrl) lines.push(link(r.settlement.explorerUrl, `Paid ${esc(r.settlement.asset)} over x402`));
  return lines.join('\n');
}

/** What the hirer sees for /status: their open jobs, newest first. */
export function jobsStatus(jobs: Job[]): string {
  if (!jobs.length) return 'Nothing is running. Tell me what you need done.';
  const text: Record<Job['status'], string> = {
    awaiting_payment: 'waiting for payment',
    awaiting_input: 'waiting for you to pick a candidate',
    running: 'in progress',
    completed: 'completed',
    failed: 'failed',
  };
  return jobs.map((j) => `• <b>${esc(j.brief.task.slice(0, 80))}</b>${j.brief.task.length > 80 ? '…' : ''}\n  ${text[j.status]}${j.result?.summary ? `: ${esc(j.result.summary)}` : j.error ? `: ${esc(j.error)}` : ''}`).join('\n');
}

const STATUS_TEXT: Partial<Record<Booking['status'], string>> = {
  pending_escrow: 'Waiting for your deposit into escrow.',
  awaiting_approval: 'Deposit received. Waiting for the operator to approve the booking.',
  placed: 'Booked. The freelancer has the order.',
  handoff: 'One step needs you to finish on the platform.',
  delivered: 'The freelancer delivered. Review it; the operator will accept or ask for a revision.',
  verifying: 'The freelancer delivered. Checking the work before any payment is released.',
  verified: 'The work passed the quality check. Waiting for the release approval.',
  in_revision: 'The freelancer was asked to fix the work.',
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
  if ((b.status === 'handoff' || b.status === 'in_revision') && b.note) lines.push(esc(b.note));
  if ((b.status === 'handoff' || b.status === 'placed') && b.url) lines.push(link(b.url, 'Open on the platform'));
  else if (b.status === 'cancelled' && b.note) lines.push(esc(b.note));
  return lines.join('\n');
}

const utc = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * How to fund the escrow. `payPageUrl` is the https page with an "Open in wallet" button (a phone cannot
 * scan its own screen; Telegram only links http(s), so the solana: URL itself is shown as copyable text).
 */
export function escrowInstructions(e: EscrowRecord, solanaRpcUrl: string, payPageUrl?: string): string {
  const lines = [`<b>Pay into escrow</b>: ${esc(e.amount)} ${esc(e.currency)}`];
  if (e.address) lines.push(`Address:\n<code>${esc(e.address)}</code>`);
  if (solanaRpcUrl.includes('devnet')) lines.push('This is a test setup: switch your wallet to devnet.');
  if (e.address) lines.push('Scan the QR code with a Solana wallet, or send the amount to the address. I will tell you when it arrives.');
  else {
    // On-chain program escrow: the QR is a Solana Pay transaction request the wallet signs.
    lines.push('Scan the QR code with a Solana wallet and approve the transaction: it locks the amount in the HAAS escrow program. I will tell you when it arrives.');
    if (e.deadline) lines.push(`If the work is not accepted by ${esc(utc(e.deadline))}, the money goes back to you.`);
  }
  if (payPageUrl) lines.push(`On this phone: ${link(payPageUrl, 'open in your wallet')}.`);
  if (e.payUrl) lines.push(`Or paste this into your wallet:\n<code>${esc(e.payUrl)}</code>`);
  return lines.join('\n');
}

/** The explorer link of the latest transaction of one kind, else the record's single explorer URL. */
function txUrl(e: EscrowRecord, kind: 'deposit' | 'release' | 'refund'): string | undefined {
  const tx = [...(e.txs ?? [])].reverse().find((t) => t.kind === kind);
  return tx?.url ?? e.explorerUrl;
}

export function escrowTimeoutLine(kind: 'deposit_expired' | 'delivery_expired', e: EscrowRecord): string {
  if (kind === 'deposit_expired') return 'The escrow deposit did not arrive in time, so I cancelled the booking.';
  const text = `The delivery was not accepted before the escrow deadline, so ${esc(e.amount)} ${esc(e.currency)} was returned to you`;
  const url = e.status === 'refunded' ? txUrl(e, 'refund') : undefined;
  return url ? `${text}. ${link(url, 'View transaction')}` : `${text}.`;
}

/** "Released 25 USDC to 7xKp…3fQa. Result hash ab12…. View transaction", with the amount and payee. */
export function escrowLine(e: EscrowRecord): string | null {
  const amount = `${esc(e.amount)} ${esc(e.currency)}`;
  let text: string;
  let url: string | undefined;
  switch (e.status) {
    case 'funded':
      text = `Escrow funded with ${amount}${e.payer ? ` from ${esc(short(e.payer))}` : ''}`;
      url = txUrl(e, 'deposit');
      break;
    case 'released':
      text = `Released ${amount} to ${e.payee ? esc(short(e.payee)) : 'the freelancer side'}`;
      if (e.resultHash) text += `. Result hash <code>${esc(short(e.resultHash, 6))}</code>`;
      url = txUrl(e, 'release');
      break;
    case 'refunded':
      text = `Refunded ${amount}${e.payer ? ` to ${esc(short(e.payer))}` : ' to you'}`;
      url = txUrl(e, 'refund');
      break;
    default:
      return null;
  }
  return url ? `${text}. ${link(url, 'View transaction')}` : `${text}.`;
}

/** The operator's view of an approval, with the job it belongs to when known. */
export function approvalRequest(a: Approval, job?: Job | null): string {
  const lines = [`<b>Approval needed</b>: ${esc(a.action)}`, esc(a.summary)];
  if (a.detail) lines.push(esc(a.detail));
  if (job) lines.push(`Job from ${esc(job.client)}: ${esc(job.brief.task.slice(0, 120))}${job.brief.task.length > 120 ? '…' : ''}`);
  if (a.bookingId) lines.push(`Booking: <code>${esc(a.bookingId)}</code>`);
  return lines.join('\n');
}

/**
 * The hirer's view of a release ('accept') or revision ('revise') approval: what QA found and the question,
 * plus the two button labels (approve, deny). Null for approvals the hirer does not answer (book, pay, cancel).
 */
export function hirerApprovalRequest(a: Approval, booking?: Booking | null): { text: string; approve: string; deny: string } | null {
  const price = booking ? usd(booking.priceUsd) : 'the budget';
  const qa = booking?.verification;
  const qaLine = qa ? `${QA_HEAD[qa.verdict]} (score ${Math.round(qa.score * 100)}/100): ${esc(qa.summary)}` : esc(a.detail ?? a.summary);
  if (a.action === 'accept') {
    return {
      text: [`<b>The freelancer delivered.</b>`, qaLine, `Release ${price} from escrow to them, or ask for a fix?`].join('\n'),
      approve: `Release ${price}`,
      deny: 'Ask for a fix',
    };
  }
  if (a.action === 'revise') {
    return {
      text: [`<b>The work needs a fix.</b>`, qaLine, 'Send the freelancer a revision request?'].join('\n'),
      approve: 'Send fix request',
      deny: 'Not now',
    };
  }
  return null;
}

/** A Cardano reputation receipt for a completed job. */
export function reputationLine(e: Extract<HaasEvent, { type: 'reputation.recorded' }>, explorer: { tx(hash: string): string; token(unit: string): string }, workerName?: string): string {
  const who = workerName ? esc(workerName) : 'The worker';
  const lines = [`<b>Recorded on Cardano.</b> ${who} now has ${e.jobsCompleted} verified job${e.jobsCompleted === 1 ? '' : 's'}${e.avgRating !== undefined ? `, rating ${e.avgRating.toFixed(1)}` : ''}.`];
  if (e.receiptUnit) lines.push(link(explorer.token(e.receiptUnit), 'Receipt NFT'));
  lines.push(link(explorer.tx(e.txHash), 'View transaction'));
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
