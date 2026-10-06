import type { Config } from '../config';
import { assertBookingTransition, canBookingTransition } from '../domain/machine';
import { newId, now } from '../domain/ids';
import type { ApprovalGate, BookingService, EscrowProvider, EventBus, SourceRegistry, Store } from '../domain/ports';
import type { Booking, BookingStatus, Brief, Candidate, EscrowRecord, FreelancerProfile, Job } from '../domain/types';

export interface BookingDeps {
  store: Store;
  bus: EventBus;
  registry: SourceRegistry;
  escrow: EscrowProvider;
  gate: ApprovalGate;
  config: Config;
}

interface Ctx {
  profile: FreelancerProfile;
  pricingIndex?: number;
}

const ctxKey = (id: string) => `booking:${id}:ctx`;
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const POLLED: BookingStatus[] = ['placed', 'in_progress', 'delivered', 'in_revision'];

export function createBookingService(deps: BookingDeps): BookingService {
  const { store, bus, registry, escrow: provider, gate } = deps;
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
    if (booking.status !== 'cancelled') booking = move(id, 'cancelled', { note: reason });
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

  async function begin(booking: Booking): Promise<void> {
    try {
      const rec = await provider.create({ bookingId: booking.id, amountUsd: booking.priceUsd });
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
    if (esc && esc.status === 'funded') saveEscrow(await provider.release(esc));
  }

  async function applyPlatformStatus(booking: Booking): Promise<void> {
    const source = registry.get(booking.source);
    if (!source?.getBookingStatus || !booking.platformRef) return;
    const st = await source.getBookingStatus(booking.platformRef);
    if (st.status === booking.status) return;
    if (st.status === 'cancelled') {
      await refundAndEnd(booking.id, 'cancelled on the platform');
      return;
    }
    if (!canBookingTransition(booking.status, st.status)) return;
    const extra = [st.deliveryText, ...(st.deliveryUrls ?? [])].filter(Boolean).join('\n');
    move(booking.id, st.status, extra ? { note: extra } : {});
    if (st.status === 'completed') await release(booking.id);
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
      void begin(booking);
      return booking;
    },

    get: (id) => store.getBooking(id),

    async accept(id) {
      const booking = need(id);
      if (!['delivered', 'placed', 'handoff', 'in_progress'].includes(booking.status)) throw new Error(`Cannot accept a booking that is ${booking.status}`);
      const { approved } = await gate.request({ action: 'accept', jobId: booking.jobId, bookingId: id, summary: `Accept delivery and release $${booking.priceUsd} (${booking.platform})` });
      if (!approved) return need(id);
      const source = registry.get(booking.source);
      if (source?.acceptDelivery && booking.platformRef) await source.acceptDelivery(booking.platformRef);
      const done = move(id, 'completed');
      await release(id);
      return done;
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

    async tick() {
      for (const booking of store.listBookings({ status: ['pending_escrow', 'escrowed', 'awaiting_approval'] })) {
        if (busy.has(booking.id)) continue;
        try {
          let esc = store.getEscrowByBooking(booking.id);
          if (!esc) continue;
          if (booking.status === 'pending_escrow' && esc.status === 'awaiting_deposit') esc = saveEscrow(await provider.refresh(esc));
          if (esc.status === 'funded') advanceInBackground(booking.id);
        } catch (err) {
          console.error(`[bookings] tick failed for ${booking.id}:`, err);
        }
      }
      for (const booking of store.listBookings({ status: ['cancelled'] })) {
        if (busy.has(booking.id)) continue;
        try {
          if (store.getEscrowByBooking(booking.id)?.status === 'funded') await refundAndEnd(booking.id, booking.note ?? 'cancelled');
        } catch (err) {
          console.error(`[bookings] tick failed for ${booking.id}:`, err);
        }
      }
      for (const booking of store.listBookings({ status: POLLED })) {
        try {
          await applyPlatformStatus(booking);
        } catch (err) {
          console.error(`[bookings] tick failed for ${booking.id}:`, err);
        }
      }
    },
  };
}
