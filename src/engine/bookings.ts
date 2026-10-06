import type { Config } from '../config';
import { assertBookingTransition, canBookingTransition } from '../domain/machine';
import { newId, now as clockNow } from '../domain/ids';
import type { ApprovalGate, BookingService, EscrowProvider, EventBus, SourceRegistry, Store } from '../domain/ports';
import type { Booking, BookingDelivery, BookingStatus, Brief, Candidate, DeliveredResult, EscrowRecord, FreelancerProfile, Job, VerificationReport } from '../domain/types';
import { deliveryHash, normaliseDelivery } from '../verify/hash';
import { qaSummaryText, revisionRequestText } from '../verify/report';
import { createResultVerifier, type ResultVerifier } from '../verify/verifier';

export interface BookingDeps {
  store: Store;
  bus: EventBus;
  registry: SourceRegistry;
  escrow: EscrowProvider;
  gate: ApprovalGate;
  config: Config;
  /** QA of deliveries. Defaults to the Claude-backed verifier (needs_human without an API key). */
  verifier?: ResultVerifier;
  /** Epoch ms; injectable for tests. */
  now?: () => number;
}

/** Extra operations on top of the BookingService contract: the QA step between delivery and release. */
export interface QaControls {
  /**
   * Records a delivery pushed by a source, webhook or channel (instead of found by polling) and starts QA.
   * A delivery identical to the one QA last judged is ignored.
   */
  deliver(id: string, delivery: DeliveredResult): Promise<Booking>;
  /** Runs QA now on a booking in 'delivered' and waits for the whole outcome (including any approval). */
  verify(id: string): Promise<Booking>;
  /** Every QA report for the booking, oldest first. */
  verifications(id: string): VerificationReport[];
  /** The latest delivery QA saw. */
  delivery(id: string): DeliveredResult | null;
}

/**
 * An escrow provider that binds its release to the verified result itself (instead of
 * release(escrow, { resultHash })); it may return the updated record or nothing (then refresh() is used).
 */
export interface VerifiedRelease {
  releaseOnVerified(bookingId: string, resultHash: string): Promise<EscrowRecord | void>;
}

interface Ctx {
  profile: FreelancerProfile;
  pricingIndex?: number;
}

const ctxKey = (id: string) => `booking:${id}:ctx`;
/** Result hash the release is bound to, kept so a failed release is retried with it. */
const resultKey = (id: string) => `booking:${id}:result`;
const deliveryKey = (id: string) => `booking:${id}:delivery`;
const qaKey = (id: string) => `booking:${id}:qa`;
/** The second failed QA (the first after the one revision) rejects the delivery. */
const MAX_QA_FAILURES = 2;
const EMPTY_BRIEF: Brief = { task: '', skills: [], remoteOk: true };
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const POLLED: BookingStatus[] = ['placed', 'in_progress', 'delivered', 'in_revision'];
/** States a person (or a verified result) may accept from. Not 'verifying': QA is running. */
const ACCEPTABLE: BookingStatus[] = ['delivered', 'verified', 'placed', 'handoff', 'in_progress', 'in_revision'];

/** Statuses where the budget is locked and the booking is not settled yet. */
const HOLDING: BookingStatus[] = ['escrowed', 'awaiting_approval', 'placed', 'handoff', 'in_progress', 'delivered', 'verifying', 'verified', 'in_revision'];
const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Who the escrow pays on release. A worker who publishes a Solana wallet is paid
 * directly. Otherwise the operator is: most platforms only take card or fiat, so the
 * operator pays the platform on the hirer's behalf and the escrow reimburses it.
 */
export const payeeFor = (profile: FreelancerProfile | undefined): string | undefined =>
  profile?.solanaWallet && BASE58_KEY.test(profile.solanaWallet) ? profile.solanaWallet : undefined;

/** On-chain escrow deadline: delivery window plus review grace, or the demo override. */
export function escrowDeadline(config: Config, brief: Brief | undefined, from: number): number {
  if (config.ESCROW_DEADLINE_MIN > 0) return from + config.ESCROW_DEADLINE_MIN * MIN;
  return from + (brief?.deadlineDays ?? config.ESCROW_DELIVERY_DAYS) * DAY + config.ESCROW_GRACE_HOURS * HOUR;
}

export function createBookingService(deps: BookingDeps): BookingService & QaControls {
  const { store, bus, registry, escrow: provider, gate, config } = deps;
  const now = deps.now ?? clockNow;
  const verifier = deps.verifier ?? createResultVerifier({ config });
  /** Bookings being advanced right now, so none is advanced twice concurrently. */
  const busy = new Set<string>();

  function need(id: string): Booking {
    const b = store.getBooking(id);
    if (!b) throw new Error(`Booking not found: ${id}`);
    return b;
  }

  function move(id: string, to: BookingStatus, patch: Partial<Booking> = {}): Booking {
    const cur = need(id);
    assertBookingTransition(cur.status, to);
    const booking = store.updateBooking(id, { ...patch, status: to });
    bus.emit({ type: 'booking.updated', booking });
    return booking;
  }

  function saveEscrow(rec: EscrowRecord): EscrowRecord {
    const saved = store.updateEscrow(rec.id, rec);
    bus.emit({ type: 'escrow.updated', escrow: saved });
    return saved;
  }

  /** Cancels, then returns the escrowed funds and ends in 'refunded'. Never throws. */
  async function refundAndEnd(id: string, reason: string): Promise<Booking> {
    let booking = need(id);
    // A QA rejection already says why; it goes straight to refunded.
    if (booking.status !== 'cancelled' && booking.status !== 'rejected') booking = move(id, 'cancelled', { note: reason });
    try {
      const esc = store.getEscrowByBooking(id);
      if (esc && esc.status !== 'refunded' && esc.status !== 'released') saveEscrow(await provider.refund(esc));
      const after = store.getEscrowByBooking(id);
      if (after && after.status !== 'refunded') {
        // The provider could not return the funds: stay 'cancelled' so tick retries.
        const b = store.updateBooking(id, { note: `${reason} (escrow ${after.status}: ${after.error ?? 'not refunded'})` });
        bus.emit({ type: 'booking.updated', booking: b });
        return b;
      }
      return move(id, 'refunded', { note: reason });
    } catch (err) {
      console.error(`[bookings] refund failed for ${id}:`, err);
      const b = store.updateBooking(id, { note: `${reason} (refund failed: ${errMsg(err)})` });
      bus.emit({ type: 'booking.updated', booking: b });
      return b;
    }
  }

  async function advance(id: string): Promise<void> {
    if (busy.has(id)) return;
    busy.add(id);
    try {
      let booking = need(id);
      const esc = store.getEscrowByBooking(id);
      if (!esc || esc.status !== 'funded') return;
      if (booking.status === 'pending_escrow') booking = move(id, 'escrowed');
      if (booking.status === 'escrowed') booking = move(id, 'awaiting_approval');
      if (booking.status !== 'awaiting_approval') return;

      const ctx = JSON.parse(store.getKv(ctxKey(id)) ?? 'null') as Ctx | null;
      const profile = ctx?.profile ?? store.getProfile(booking.profileId);
      if (!profile) {
        await refundAndEnd(id, 'freelancer profile is missing');
        return;
      }
      const brief: Brief = store.getJob(booking.jobId)?.brief ?? { task: '', skills: [], remoteOk: true };

      let approved: boolean;
      let note: string | undefined;
      try {
        const res = await gate.request({
          action: 'book',
          jobId: booking.jobId,
          bookingId: id,
          summary: `Book ${profile.name} on ${booking.platform} for $${booking.priceUsd}`,
          detail: `${profile.headline}\n${profile.url}\nBudget is held in escrow (${esc.amount} ${esc.currency}).`,
        });
        approved = res.approved;
        note = res.approval?.note;
      } catch (err) {
        await refundAndEnd(id, `approval failed: ${errMsg(err)}`);
        return;
      }
      if (!approved) {
        await refundAndEnd(id, `booking not approved${note ? `: ${note}` : ''}`);
        return;
      }
      // The approval can take long: do not book against a budget that timed out meanwhile.
      const still = store.getEscrowByBooking(id);
      if (need(id).status !== 'awaiting_approval' || still?.status !== 'funded') return;
      if (still.deadline && now() >= still.deadline) {
        await expireDelivery(need(id), still);
        return;
      }

      const source = registry.get(booking.source);
      if (!source?.book) {
        move(id, 'handoff', { url: profile.url, note: `${booking.platform} cannot be booked automatically; book ${profile.name} at ${profile.url}.` });
        return;
      }
      try {
        const result = await source.book({ bookingId: id, profile, brief, priceUsd: booking.priceUsd, pricingIndex: ctx?.pricingIndex });
        if (result.kind === 'placed') move(id, 'placed', { platformRef: result.platformRef, url: result.url ?? profile.url });
        else move(id, 'handoff', { platformRef: result.platformRef, url: result.url, note: result.instructions });
      } catch (err) {
        await refundAndEnd(id, `booking failed: ${errMsg(err)}`);
      }
    } finally {
      busy.delete(id);
    }
  }

  const advanceInBackground = (id: string) =>
    void advance(id).catch((err) => console.error(`[bookings] advance failed for ${id}:`, err));

  async function begin(booking: Booking, brief: Brief): Promise<void> {
    try {
      const ctx = JSON.parse(store.getKv(ctxKey(booking.id)) ?? 'null') as Ctx | null;
      const payee = payeeFor(ctx?.profile ?? store.getProfile(booking.profileId) ?? undefined);
      const deadline = escrowDeadline(config, brief, now());
      if (payee) store.updateBooking(booking.id, { payeeWallet: payee });
      const rec = await provider.create({ bookingId: booking.id, amountUsd: booking.priceUsd, payee, deadline });
      store.insertEscrow(rec);
      bus.emit({ type: 'escrow.updated', escrow: rec });
      const updated = store.updateBooking(booking.id, { escrowId: rec.id });
      bus.emit({ type: 'booking.updated', booking: updated });
      if (rec.status === 'funded') await advance(booking.id);
    } catch (err) {
      console.error(`[bookings] escrow setup failed for ${booking.id}:`, err);
      if (need(booking.id).status === 'pending_escrow') move(booking.id, 'cancelled', { note: `escrow setup failed: ${errMsg(err)}` });
    }
  }

  async function release(id: string): Promise<void> {
    const esc = store.getEscrowByBooking(id);
    if (!esc || esc.status !== 'funded') return;
    // The verified result hash goes on chain with the release (and is kept for a retry by tick).
    const hash = need(id).resultHash ?? store.getKv(resultKey(id)) ?? undefined;
    const bound = provider as EscrowProvider & Partial<VerifiedRelease>;
    if (hash && typeof bound.releaseOnVerified === 'function') {
      const rec = await bound.releaseOnVerified(id, hash);
      saveEscrow(rec ?? (await provider.refresh(esc)));
      return;
    }
    saveEscrow(await provider.release(esc, hash ? { resultHash: hash } : {}));
  }
  /** Never funded within the deposit window: cancel the booking, nothing to return. */
  function expireDeposit(booking: Booking, esc: EscrowRecord): void {
    const reason = `escrow deposit not received within ${config.ESCROW_DEPOSIT_TIMEOUT_MIN} min`;
    const saved = saveEscrow({ ...esc, status: 'failed', error: reason, updatedAt: now() });
    const cancelled = move(booking.id, 'cancelled', { note: reason });
    bus.emit({ type: 'escrow.timeout', kind: 'deposit_expired', booking: cancelled, escrow: saved });
  }

  /** Funded but no accepted delivery by the on-chain deadline: return the budget to the hirer. */
  async function expireDelivery(booking: Booking, esc: EscrowRecord): Promise<void> {
    const ended = await refundAndEnd(booking.id, 'delivery was not accepted before the escrow deadline');
    bus.emit({ type: 'escrow.timeout', kind: 'delivery_expired', booking: ended, escrow: store.getEscrowByBooking(booking.id) ?? esc });
  }

  // ------------------------------------------------------------------ QA

  const history = (id: string): VerificationReport[] => JSON.parse(store.getKv(qaKey(id)) ?? '[]') as VerificationReport[];
  const loadDelivery = (id: string): DeliveredResult | null => JSON.parse(store.getKv(deliveryKey(id)) ?? 'null') as DeliveredResult | null;

  function record(id: string, report: VerificationReport): Booking {
    store.setKv(qaKey(id), JSON.stringify([...history(id), report]));
    const booking = store.updateBooking(id, { verification: report });
    bus.emit({ type: 'verification.completed', booking, report });
    return booking;
  }

  /** Acceptance on the platform, 'completed', then escrow release bound to the verified result hash. */
  async function finishAccept(id: string, resultHash?: string): Promise<Booking> {
    const booking = need(id);
    const esc = store.getEscrowByBooking(id);
    // Past the on-chain deadline the program only refunds; tick does that.
    if (esc?.status === 'funded' && esc.deadline && now() >= esc.deadline) throw new Error('the escrow deadline has passed; the budget can only be refunded');
    const hash = resultHash ?? booking.verification?.resultHash;
    if (hash) store.setKv(resultKey(id), hash);
    const source = registry.get(booking.source);
    if (source?.acceptDelivery && booking.platformRef) await source.acceptDelivery(booking.platformRef);
    move(id, 'completed', { ...(hash && { resultHash: hash }), ...(resultHash && { note: `delivery verified (${resultHash})` }) });
    // A failed release is retried by tick (completed + funded), with the same result hash.
    await release(id).catch((err) => console.error(`[bookings] release failed for ${id}:`, err));
    return need(id);
  }

  /** A failed QA run (or a hirer's refusal): one revision request, then rejection and refund. */
  async function onFail(id: string, report: VerificationReport): Promise<Booking> {
    const failures = history(id).filter((r) => r.verdict === 'fail').length;
    if (failures >= MAX_QA_FAILURES) {
      const rejected = move(id, 'rejected', { note: `Rejected by QA: ${report.summary}` });
      bus.emit({ type: 'verification.rejected', booking: rejected, report });
      return refundAndEnd(id, `rejected after ${failures} failed checks: ${report.summary}`);
    }
    const booking = need(id);
    const text = revisionRequestText(report);
    // The policy makes this automatic by default (AUTO_QA_REVISION); otherwise a person approves it.
    const res = await gate.request({
      action: 'revise',
      jobId: booking.jobId,
      bookingId: id,
      summary: `QA failed: ask the freelancer for a revision (${booking.platform})`,
      detail: `${qaSummaryText(report)}\n\nMessage to the freelancer:\n${text}`,
    });
    const cur = need(id);
    if (!['verifying', 'verified', 'delivered'].includes(cur.status)) return cur;
    if (!res.approved) {
      return cur.status === 'verifying' ? move(id, 'delivered', { note: `QA failed; no revision was requested. ${report.summary}` }) : cur;
    }
    const source = registry.get(cur.source);
    if (source?.requestRevision && cur.platformRef) await source.requestRevision(cur.platformRef, text);
    const revised = move(id, 'in_revision', { note: text });
    bus.emit({ type: 'verification.revision_requested', booking: revised, report, text });
    return revised;
  }

  /** "Confirm before release": the hirer sees the QA report and approves, unless the policy auto-releases small passed jobs. */
  async function askRelease(id: string, report: VerificationReport): Promise<Booking> {
    const booking = need(id);
    const head = report.verdict === 'pass' ? 'QA passed' : 'QA needs your review';
    const res = await gate.request({
      action: 'accept',
      jobId: booking.jobId,
      bookingId: id,
      summary: `${head}: accept delivery and release $${booking.priceUsd} (${booking.platform})`,
      detail: qaSummaryText(report),
    });
    const cur = need(id);
    // Someone acted meanwhile (manual accept, cancel) or a newer delivery replaced this one.
    if ((cur.status !== 'verified' && cur.status !== 'delivered') || cur.verification?.deliveryHash !== report.deliveryHash) return cur;
    if (res.approved) return finishAccept(id);
    if (res.approval?.status === 'denied') {
      const by = res.approval.decidedBy ?? 'the hirer';
      const note = res.approval.note;
      const human: VerificationReport = {
        ...report,
        verdict: 'fail',
        checks: [...report.checks, { name: 'hirer_review', ok: false, detail: note || 'the hirer did not accept the delivery', by: 'human' }],
        summary: `Not accepted by ${by}${note ? `: ${note}` : ''}.`,
        at: Date.now(),
      };
      record(id, human);
      return onFail(id, human);
    }
    const waiting = store.updateBooking(id, { note: `${head}. The release approval expired: accept, revise or cancel by hand.` });
    bus.emit({ type: 'booking.updated', booking: waiting });
    return waiting;
  }

  /** delivered -> verifying -> verified (approval, release) | in_revision | rejected (refund) | delivered (needs a person). */
  async function runQa(id: string): Promise<Booking> {
    if (busy.has(id)) return need(id);
    busy.add(id);
    try {
      let booking = need(id);
      if (booking.status !== 'delivered') return booking;
      const job = store.getJob(booking.jobId);
      const attempt = history(id).length + 1;
      booking = move(id, 'verifying');
      bus.emit({ type: 'verification.started', bookingId: id, jobId: booking.jobId, attempt });
      const report = await verifier.verify({
        bookingId: id,
        brief: job?.brief ?? EMPTY_BRIEF,
        delivery: loadDelivery(id) ?? {},
        priceUsd: booking.priceUsd,
        attempt,
        identifier: job?.payment?.identifierFromPurchaser,
      });
      record(id, report);
      if (report.verdict === 'pass') {
        move(id, 'verified', { note: report.summary });
        return await askRelease(id, report);
      }
      if (report.verdict === 'fail') return await onFail(id, report);
      move(id, 'delivered', { note: `QA needs a person: ${report.summary}` });
      return await askRelease(id, report);
    } catch (err) {
      console.error(`[bookings] QA failed for ${id}:`, err);
      if (need(id).status === 'verifying') return move(id, 'delivered', { note: `QA could not finish: ${errMsg(err)}` });
      return need(id);
    } finally {
      busy.delete(id);
    }
  }

  const qaInBackground = (id: string) => void runQa(id).catch((err) => console.error(`[bookings] QA failed for ${id}:`, err));

  /** Stores a delivery and moves to 'delivered'. False when it is the one QA already judged, or the move is illegal. */
  function takeDelivery(booking: Booking, d: DeliveredResult, summary?: string): boolean {
    const delivery = normaliseDelivery(d);
    // A re-read of the delivery QA already judged (e.g. the platform still shows it while in revision) is not new work.
    if (booking.verification?.deliveryHash === deliveryHash(delivery)) return false;
    if (booking.status !== 'delivered' && !canBookingTransition(booking.status, 'delivered')) return false;
    store.setKv(deliveryKey(booking.id), JSON.stringify(delivery));
    const note = [delivery.text, ...(delivery.urls ?? [])].filter(Boolean).join('\n');
    // Kept on the booking so the job result can carry the work itself (e.g. a bounty's fields).
    const shown: BookingDelivery = { text: delivery.text, summary: summary?.trim() || undefined, data: delivery.fields, urls: delivery.urls, at: now() };
    if (booking.status !== 'delivered') move(booking.id, 'delivered', { delivery: shown, ...(note && { note }) });
    else bus.emit({ type: 'booking.updated', booking: store.updateBooking(booking.id, { delivery: shown }) });
    return true;
  }

  async function applyPlatformStatus(booking: Booking): Promise<void> {
    const source = registry.get(booking.source);
    if (!source?.getBookingStatus || !booking.platformRef) return;
    const st = await source.getBookingStatus(booking.platformRef);
    if (st.status === 'cancelled') {
      if (booking.status !== 'cancelled') await refundAndEnd(booking.id, 'cancelled on the platform');
      return;
    }
    // The platform saying "completed" is not enough to pay: it is treated as a delivery and goes through QA.
    const status = st.status === 'completed' ? 'delivered' : st.status;
    if (status === 'delivered') {
      if (takeDelivery(booking, { text: st.deliveryText, urls: st.deliveryUrls, fields: st.deliveryData }, st.deliverySummary)) qaInBackground(booking.id);
      return;
    }
    if (status === booking.status || !canBookingTransition(booking.status, status)) return;
    const extra = [st.deliveryText, ...(st.deliveryUrls ?? [])].filter(Boolean).join('\n');
    move(booking.id, status, extra ? { note: extra } : {});
  }

  return {
    create(job: Job, candidate: Candidate) {
      const profile = candidate.profile;
      const source = registry.all().find((s) => s.platform === profile.platform)?.name ?? profile.platform;
      const t = now();
      const booking: Booking = {
        id: newId('bk'),
        jobId: job.id,
        profileId: profile.id,
        platform: profile.platform,
        source,
        status: 'pending_escrow',
        priceUsd: candidate.quoteUsd ?? job.brief.budgetUsd ?? 0,
        paused: false,
        createdAt: t,
        updatedAt: t,
      };
      const ctx: Ctx = { profile, pricingIndex: candidate.pricingIndex };
      store.insertBooking(booking);
      store.setKv(ctxKey(booking.id), JSON.stringify(ctx));
      bus.emit({ type: 'booking.updated', booking });
      void begin(booking, job.brief);
      return booking;
    },

    get: (id) => store.getBooking(id),

    async accept(id) {
      const booking = need(id);
      if (!ACCEPTABLE.includes(booking.status)) throw new Error(`Cannot accept a booking that is ${booking.status}`);
      // A manual accept is a person's override; the approval shows what QA found, or that it never ran.
      const qa = booking.verification;
      const detail = qa ? qaSummaryText(qa) : 'No delivery has been checked by QA: accepting releases the budget on your word alone.';
      const { approved } = await gate.request({ action: 'accept', jobId: booking.jobId, bookingId: id, summary: `Accept delivery and release $${booking.priceUsd} (${booking.platform})`, detail });
      if (!approved) return need(id);
      if (!ACCEPTABLE.includes(need(id).status)) return need(id);
      return finishAccept(id);
    },

    async releaseOnVerified(id, resultHash, opts = {}) {
      const booking = need(id);
      if (!ACCEPTABLE.includes(booking.status)) throw new Error(`Cannot release a booking that is ${booking.status}`);
      const esc = store.getEscrowByBooking(id);
      if (esc?.status === 'funded' && esc.deadline && now() >= esc.deadline) throw new Error('the escrow deadline has passed; the budget can only be refunded');
      if (!opts.preApproved) {
        const to = booking.payeeWallet ? `the worker's wallet ${booking.payeeWallet}` : 'the operator';
        const { approved } = await gate.request({
          action: 'accept',
          jobId: booking.jobId,
          bookingId: id,
          summary: `Delivery verified: accept and release $${booking.priceUsd} to ${to} (${booking.platform})`,
          detail: `Result hash ${resultHash}`,
        });
        if (!approved) return need(id);
      }
      // Someone acted while the approval was open.
      if (!ACCEPTABLE.includes(need(id).status)) return need(id);
      return finishAccept(id, resultHash || undefined);
    },

    async requestRevision(id, text) {
      const booking = need(id);
      const { approved } = await gate.request({ action: 'revise', jobId: booking.jobId, bookingId: id, summary: `Request a revision (${booking.platform})`, detail: text });
      if (!approved) return need(id);
      const source = registry.get(booking.source);
      if (source?.requestRevision && booking.platformRef) await source.requestRevision(booking.platformRef, text);
      return move(id, 'in_revision', { note: text });
    },

    async cancel(id, reason) {
      const booking = need(id);
      if (booking.status === 'completed' || booking.status === 'refunded') throw new Error(`Cannot cancel a booking that is ${booking.status}`);
      const { approved } = await gate.request({ action: 'cancel', jobId: booking.jobId, bookingId: id, summary: `Cancel booking and refund $${booking.priceUsd} (${booking.platform})`, detail: reason });
      if (!approved) return need(id);
      return refundAndEnd(id, reason);
    },

    async deliver(id, delivery) {
      const booking = need(id);
      if (takeDelivery(booking, delivery)) qaInBackground(id);
      return need(id);
    },

    verify: (id) => runQa(id),
    verifications: (id) => history(id),
    delivery: (id) => loadDelivery(id),

    async tick() {
      for (const booking of store.listBookings({ status: ['pending_escrow', 'escrowed', 'awaiting_approval'] })) {
        if (busy.has(booking.id)) continue;
        try {
          let esc = store.getEscrowByBooking(booking.id);
          if (!esc) continue;
          if (booking.status === 'pending_escrow' && esc.status === 'awaiting_deposit') esc = saveEscrow(await provider.refresh(esc));
          if (booking.status === 'pending_escrow' && esc.status === 'failed') {
            // e.g. a deposit in the wrong mint or amount: return whatever arrived.
            await refundAndEnd(booking.id, esc.error ?? 'escrow deposit rejected');
            continue;
          }
          if (booking.status === 'pending_escrow' && esc.status === 'awaiting_deposit') {
            if (now() >= esc.createdAt + config.ESCROW_DEPOSIT_TIMEOUT_MIN * MIN) expireDeposit(booking, esc);
            continue;
          }
          if (esc.status === 'funded') advanceInBackground(booking.id);
        } catch (err) {
          console.error(`[bookings] tick failed for ${booking.id}:`, err);
        }
      }
      for (const booking of store.listBookings({ status: HOLDING })) {
        if (busy.has(booking.id)) continue;
        const esc = store.getEscrowByBooking(booking.id);
        if (esc?.status !== 'funded' || !esc.deadline || now() < esc.deadline) continue;
        try {
          await expireDelivery(booking, esc);
        } catch (err) {
          console.error(`[bookings] tick failed for ${booking.id}:`, err);
        }
      }
      for (const booking of store.listBookings({ status: ['cancelled', 'rejected'] })) {
        if (busy.has(booking.id)) continue;
        try {
          const esc = store.getEscrowByBooking(booking.id);
          // Funded, or a rejected deposit that still holds the hirer's money on chain.
          if (esc?.status === 'funded' || (esc?.status === 'failed' && esc.payer)) await refundAndEnd(booking.id, booking.note ?? 'cancelled');
        } catch (err) {
          console.error(`[bookings] tick failed for ${booking.id}:`, err);
        }
      }
      // QA left unfinished by a restart: re-run it on the stored delivery.
      for (const booking of store.listBookings({ status: ['verifying', 'delivered'] })) {
        if (busy.has(booking.id)) continue;
        try {
          const d = loadDelivery(booking.id);
          if (!d) continue;
          if (booking.status === 'verifying') move(booking.id, 'delivered');
          else if (booking.verification?.deliveryHash === deliveryHash(d)) continue;
          qaInBackground(booking.id);
        } catch (err) {
          console.error(`[bookings] tick failed for ${booking.id}:`, err);
        }
      }
      for (const booking of store.listBookings({ status: ['completed'] })) {
        try {
          if (store.getEscrowByBooking(booking.id)?.status === 'funded') await release(booking.id);
        } catch (err) {
          console.error(`[bookings] release retry failed for ${booking.id}:`, err);
        }
      }
      for (const booking of store.listBookings({ status: POLLED })) {
        if (busy.has(booking.id)) continue;
        try {
          await applyPlatformStatus(booking);
        } catch (err) {
          console.error(`[bookings] tick failed for ${booking.id}:`, err);
        }
      }
    },
  };
}
