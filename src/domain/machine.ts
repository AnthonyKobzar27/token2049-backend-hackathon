import type { BookingStatus, JobStatus } from './types';

// Every status change in the engine goes through these tables.

const JOB: Record<JobStatus, JobStatus[]> = {
  awaiting_payment: ['running', 'failed'],
  running: ['awaiting_input', 'completed', 'failed'],
  awaiting_input: ['running', 'completed', 'failed'],
  completed: [],
  failed: [],
};

const BOOKING: Record<BookingStatus, BookingStatus[]> = {
  pending_escrow: ['escrowed'],
  escrowed: ['awaiting_approval'],
  awaiting_approval: ['placed', 'handoff'],
  placed: ['in_progress', 'delivered', 'in_revision', 'completed'],
  handoff: ['placed', 'in_progress', 'delivered', 'in_revision', 'completed'],
  in_progress: ['delivered', 'in_revision', 'completed'],
  delivered: ['in_revision', 'completed', 'verifying', 'rejected'],
  in_revision: ['in_progress', 'delivered', 'completed'],
  // QA between delivery and acceptance. needs_human goes back to 'delivered' to wait for a person.
  verifying: ['verified', 'delivered', 'in_revision', 'rejected'],
  verified: ['completed', 'in_revision', 'rejected'],
  rejected: [],
  completed: [],
  cancelled: ['refunded'],
  refunded: [],
};

// cancelled and refunded are reachable from every non-final state.
for (const [from, to] of Object.entries(BOOKING) as [BookingStatus, BookingStatus[]][]) {
  if (from === 'completed' || from === 'refunded') continue;
  for (const end of ['cancelled', 'refunded'] as const) if (from !== end && !to.includes(end)) to.push(end);
}

export const canJobTransition = (from: JobStatus, to: JobStatus): boolean => JOB[from].includes(to);
export const canBookingTransition = (from: BookingStatus, to: BookingStatus): boolean => BOOKING[from].includes(to);

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canJobTransition(from, to)) throw new Error(`Illegal job transition ${from} -> ${to}`);
}

export function assertBookingTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canBookingTransition(from, to)) throw new Error(`Illegal booking transition ${from} -> ${to}`);
}
