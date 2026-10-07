// First-party bounty board: HAAS's own registered workers take short, real-world microtasks
// (a phone call, a pickup, a photo of a noticeboard) and submit a structured result.

import type { BountyStatus, Ms } from '../domain/types';

export type { BountyStatus };

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** How a worker is reached. Each channel is optional; a WorkerNotifier picks the ones it serves. */
export interface WorkerContact {
  /** Telegram chat id (equal to the user id in a private chat). */
  telegramId?: string;
  /** Phone or Apple ID for iMessage (a notifier for it can be added later). */
  imessage?: string;
  email?: string;
}

export interface Worker {
  /** e.g. "w_alice". */
  id: string;
  name: string;
  /** Public handle, e.g. "@alice". */
  handle?: string;
  contact: WorkerContact;
  wallets: { cardano?: string; solana?: string };
  location: GeoPoint & { city: string; area?: string; country: string };
  skills: string[];
  /** False when the worker has paused new offers. */
  available: boolean;
  /** 0 to 5. */
  rating?: number;
  completed: number;
  /** Identity checked by the operator; only verified workers are offered bounties. */
  verified: boolean;
  languages?: string[];
  /** Secret the worker sends to the Telegram bot (/link <code>) to connect their chat. */
  linkCode: string;
  createdAt: Ms;
}

export type FieldType = 'text' | 'date' | 'time' | 'number' | 'url' | 'phone';

/** One field the worker fills in when submitting. */
export interface ResultField {
  /** Machine key, e.g. "reference". */
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  hint?: string;
}

/** What the bounty asks for, derived from the brief. */
export interface BountySpec {
  /** Short line shown to workers, e.g. "Phone call, ~5 min, book a physio slot, S$3". */
  title: string;
  kind: 'phone_call' | 'on_site' | 'errand' | 'online' | 'other';
  estMinutes: number;
  /** Instructions for the worker. */
  instructions: string;
  fields: ResultField[];
  /** One-line summary with {key} placeholders, e.g. "Booked: {date} {time}, ref {reference}". */
  summaryTemplate: string;
  /** Where the task happens, when it is tied to a place. */
  place?: { name: string; point?: GeoPoint };
  derivedBy: 'llm' | 'rules';
}

export interface BountyResult {
  /** Field values as the worker entered them (validated against spec.fields). */
  data: Record<string, string>;
  summary: string;
  photoUrl?: string;
  notes?: string;
  submittedAt: Ms;
}

/** Outcome of the check run on a submission before the client sees it. */
export interface QaVerdict {
  ok: boolean;
  /** Plain lines the worker can act on. Empty when ok. */
  issues: string[];
  by: 'rules' | 'llm' | 'operator';
  at: Ms;
}

export interface BountyOffer {
  workerId: string;
  /** Secret in the worker's page link /w/:token. */
  token: string;
  offeredAt: Ms;
}

export interface BountyMessage {
  id: string;
  from: 'worker' | 'agent';
  text: string;
  at: Ms;
}

export interface Bounty {
  id: string;
  /** Short code workers type in Telegram, e.g. "K7Q2". */
  code: string;
  bookingId?: string;
  jobId?: string;
  task: string;
  spec: BountySpec;
  rewardUsd: number;
  /** As shown to workers, e.g. { amount: 3, currency: 'SGD' }. */
  reward: { amount: number; currency: string };
  status: BountyStatus;
  mode: 'broadcast' | 'direct';
  offers: BountyOffer[];
  workerId?: string;
  claimBy: Ms;
  /** Set on claim. */
  submitBy?: Ms;
  claimedAt?: Ms;
  result?: BountyResult;
  /** Feedback from verification when a revision was asked. */
  feedback?: string;
  /** Latest check of the submission. */
  qa?: QaVerdict;
  /** How many times the submission was sent back. */
  revisions?: number;
  messages: BountyMessage[];
  payout?: { chain: 'cardano' | 'solana' | 'none'; address?: string; ref?: string; at: Ms };
  reason?: string;
  createdAt: Ms;
  updatedAt: Ms;
}
