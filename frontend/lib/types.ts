// Mirrors the backend contract in src/domain/types.ts (trimmed to what the UI reads).
// Keep field names in sync with that file; the API serves these shapes verbatim.

export type Ms = number;

export interface Brief {
  task: string;
  skills: string[];
  budgetUsd?: number;
  deadlineDays?: number;
  location?: string;
  timezone?: string;
  remoteOk: boolean;
  hoursNeeded?: number;
  language?: string;
  notes?: string;
}

export interface Pricing {
  kind: 'fixed' | 'hourly';
  amountUsd: number;
  label?: string;
  deliveryDays?: number;
  revisions?: number | 'unlimited';
}

export interface FreelancerProfile {
  id: string;
  platform: string;
  url: string;
  name: string;
  headline: string;
  description?: string;
  skills: string[];
  country?: string;
  city?: string;
  languages?: string[];
  pricing: Pricing[];
  rating?: number;
  reviewCount?: number;
  level?: string;
  verified?: boolean;
  fetchedAt: Ms;
}

export interface Subscores {
  suitability: number | null;
  price: number | null;
  rating: number | null;
  availability: number | null;
  speed: number | null;
}

export interface Candidate {
  profile: FreelancerProfile;
  score: number;
  subscores: Subscores;
  reason: string;
  unknowns: string[];
  quoteUsd?: number;
  pricingIndex?: number;
}

export interface SourceStatus {
  source: string;
  ok: boolean;
  count: number;
  cached: boolean;
  ms: number;
  error?: string;
}

export interface Shortlist {
  id: string;
  jobId: string;
  round: number;
  candidates: Candidate[];
  sources: SourceStatus[];
  createdAt: Ms;
}

export type JobStatus = 'awaiting_payment' | 'awaiting_input' | 'running' | 'completed' | 'failed';

export interface JobResult {
  outcome: 'booked' | 'handoff' | 'no_booking';
  summary: string;
  freelancer?: Pick<FreelancerProfile, 'id' | 'platform' | 'name' | 'url' | 'headline'>;
  priceUsd?: number;
  bookingId?: string;
  bookingUrl?: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  client: string;
  clientRef?: string;
  brief: Brief;
  round: number;
  shortlistId?: string;
  selectedProfileId?: string;
  bookingId?: string;
  result?: JobResult;
  error?: string;
  createdAt: Ms;
  updatedAt: Ms;
}

export type BookingStatus =
  | 'pending_escrow'
  | 'escrowed'
  | 'awaiting_approval'
  | 'placed'
  | 'handoff'
  | 'in_progress'
  | 'delivered'
  | 'in_revision'
  | 'completed'
  | 'cancelled'
  | 'refunded';

export interface Booking {
  id: string;
  jobId: string;
  profileId: string;
  platform: string;
  status: BookingStatus;
  priceUsd: number;
  platformRef?: string;
  url?: string;
  paused: boolean;
  note?: string;
  createdAt: Ms;
  updatedAt: Ms;
}

export interface ConversationMessage {
  id: string;
  jobId: string;
  bookingId?: string;
  thread: 'hirer' | 'freelancer';
  from: 'hirer' | 'freelancer' | 'agent' | 'operator';
  text: string;
  createdAt: Ms;
}

export interface Approval {
  id: string;
  action: string;
  jobId?: string;
  bookingId?: string;
  summary: string;
  detail?: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  decidedBy?: string;
  note?: string;
  createdAt: Ms;
  decidedAt?: Ms;
}

export interface EscrowRecord {
  id: string;
  bookingId: string;
  provider: string;
  status: 'awaiting_deposit' | 'funded' | 'released' | 'refunded' | 'failed';
  amount: number;
  currency: string;
  address?: string;
  payUrl?: string;
  explorerUrl?: string;
  createdAt: Ms;
  updatedAt: Ms;
}

export type HaasEvent =
  | { type: 'job.updated'; job: Job }
  | { type: 'job.progress'; jobId: string; message: string }
  | { type: 'shortlist.ready'; job: Job; shortlist: Shortlist }
  | { type: 'booking.updated'; booking: Booking }
  | { type: 'escrow.updated'; escrow: EscrowRecord }
  | { type: 'approval.requested'; approval: Approval }
  | { type: 'approval.resolved'; approval: Approval }
  | { type: 'conversation.message'; message: ConversationMessage }
  | { type: 'operator.attention'; source: string; message: string; url?: string };

export interface ActivityEntry {
  seq: number;
  at: Ms;
  event: HaasEvent;
}

export interface Overview {
  jobs: { total: number; running: number; awaitingInput: number; awaitingPayment: number; completed: number; failed: number };
  pendingApprovals: number;
  openBookings: number;
  sources: { name: string; kind: string; enabled: boolean }[];
}

export interface CandidateEntry {
  jobId: string;
  jobStatus: JobStatus;
  task: string;
  round: number;
  selected: boolean;
  candidate: Candidate;
}

export interface JobDetail {
  job: Job;
  shortlist: Shortlist | null;
  bookings: Booking[];
  escrows: EscrowRecord[];
  messages: ConversationMessage[];
}

export interface TokenInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: Ms;
  lastUsedAt?: Ms;
  revoked?: boolean;
  /** Present only in the create response. */
  secret?: string;
}

export interface Hire {
  bookingId: string;
  jobId: string;
  task?: string;
  status: BookingStatus;
  priceUsd: number;
  platform: string;
  url?: string;
  name: string;
  headline?: string;
  rating?: number;
  reviewCount?: number;
  score?: number;
  reason?: string;
  hiredAt: Ms;
}

export interface HistoryEvent {
  at: Ms;
  jobId?: string;
  task?: string;
  kind: 'task' | 'shortlist' | 'hire' | 'approval' | 'approved' | 'denied' | 'done' | 'failed' | string;
  title: string;
  detail?: string;
}

export interface History {
  hires: Hire[];
  events: HistoryEvent[];
}
