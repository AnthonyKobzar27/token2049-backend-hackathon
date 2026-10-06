// Shared domain types. This file is a contract between modules: do not change it
// from inside a module; raise the need instead.

/** Epoch milliseconds. */
export type Ms = number;

export type Platform =
  | 'freelancer'
  | 'rentahuman'
  | 'fiverr'
  | 'upwork'
  | 'peopleperhour'
  | 'guru'
  | 'fake'
  | (string & {});

// ---------------------------------------------------------------- brief

/** What the person hiring needs. Everything except `task` may be unknown. */
export interface Brief {
  task: string;
  skills: string[];
  /** Ceiling for the whole job, in USD. */
  budgetUsd?: number;
  /** Days from now by which the work must be delivered. */
  deadlineDays?: number;
  /** Free text: country or city the freelancer should be in or near. */
  location?: string;
  /** IANA zone of the person hiring, for working-hours overlap. */
  timezone?: string;
  /** False when the work must be done on site at `location`. */
  remoteOk: boolean;
  /** Estimated hours of work; used to compare hourly and fixed prices. */
  hoursNeeded?: number;
  /** ISO 639-1 code the freelancer must work in. */
  language?: string;
  notes?: string;
}

// -------------------------------------------------------------- profiles

export interface Pricing {
  kind: 'fixed' | 'hourly';
  amountUsd: number;
  /** As published, when not USD. */
  original?: { amount: number; currency: string };
  /** Package or tier name, e.g. "Basic". */
  label?: string;
  deliveryDays?: number;
  revisions?: number | 'unlimited';
}

export interface Availability {
  online?: boolean;
  /** Typical hours to first reply. */
  responseHours?: number;
  hoursPerWeek?: number;
}

/** One freelancer (or one gig of theirs) normalised across platforms. */
export interface FreelancerProfile {
  /** `${platform}:${platformId}` */
  id: string;
  platform: Platform;
  platformId: string;
  url: string;
  name: string;
  headline: string;
  description?: string;
  skills: string[];
  category?: string;
  /** ISO 3166-1 alpha-2 when known, otherwise the name as published. */
  country?: string;
  city?: string;
  timezone?: string;
  /** ISO 639-1 codes. */
  languages?: string[];
  availability?: Availability;
  /** Empty when the platform does not publish a price. */
  pricing: Pricing[];
  /** 0 to 5. */
  rating?: number;
  reviewCount?: number;
  /** Platform level or badge, e.g. "Top Rated", "Level 2". */
  level?: string;
  verified?: boolean;
  fetchedAt: Ms;
}

// -------------------------------------------------------------- matching

export interface Subscores {
  /** Each 0 to 1, or null when the inputs are unknown. */
  suitability: number | null;
  price: number | null;
  rating: number | null;
  availability: number | null;
  speed: number | null;
}

export interface Candidate {
  profile: FreelancerProfile;
  /** 0 to 100. */
  score: number;
  subscores: Subscores;
  /** One line a person can read. */
  reason: string;
  /** Things the platform does not publish, e.g. "hours per week". */
  unknowns: string[];
  /** Estimated total for this brief in USD, when it can be computed. */
  quoteUsd?: number;
  /** Index into profile.pricing that quoteUsd is based on. */
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

export interface SuitabilityScore {
  /** 0 to 1. */
  score: number;
  reason: string;
}

// ------------------------------------------------------------------ jobs

/** MIP-003 job statuses. */
export type JobStatus = 'awaiting_payment' | 'awaiting_input' | 'running' | 'completed' | 'failed';

export type JobClient = 'masumi' | 'telegram' | 'x402' | 'local' | 'sokosumi';

/** Masumi payment terms returned from /start_job. Times are epoch ms. */
export interface JobPayment {
  blockchainIdentifier: string;
  agentIdentifier: string;
  sellerVKey: string;
  identifierFromPurchaser: string;
  inputHash: string;
  payByTime: Ms;
  submitResultTime: Ms;
  unlockTime: Ms;
  externalDisputeUnlockTime: Ms;
  paidAt?: Ms;
  resultSubmittedAt?: Ms;
  /** Dynamic pricing: the amounts requested for this job (atomic units; unit "" is lovelace). */
  amounts?: { amount: string; unit: string }[];
  /** V2 payment sources: the source type and index the buyer must echo in POST /purchase. */
  paymentSourceType?: string;
  supportedPaymentSourceIndex?: number;
  smartContractAddress?: string;
  /** The result hash submitted on chain. */
  resultHash?: string;
  /** Last on-chain state seen for the escrow, e.g. FundsLocked, ResultSubmitted, Withdrawn. */
  onChainState?: string;
  /** Seller collection (withdrawal after unlockTime), done by the payment service. */
  collectedAt?: Ms;
  collectionTxHash?: string;
}

export interface JobResult {
  outcome: 'booked' | 'handoff' | 'no_booking';
  summary: string;
  freelancer?: Pick<FreelancerProfile, 'id' | 'platform' | 'name' | 'url' | 'headline'>;
  priceUsd?: number;
  bookingId?: string;
  bookingRef?: string;
  bookingUrl?: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  client: JobClient;
  /** Client-side reference, e.g. Telegram chat id. */
  clientRef?: string;
  brief: Brief;
  round: number;
  shortlistId?: string;
  selectedProfileId?: string;
  bookingId?: string;
  payment?: JobPayment;
  result?: JobResult;
  error?: string;
  createdAt: Ms;
  updatedAt: Ms;
}

/** What the person hiring can answer at a check-in. */
export type UserInput =
  | { action: 'confirm'; profileId: string }
  | { action: 'refine'; feedback: string; brief?: Partial<Brief> }
  | { action: 'cancel' };

// -------------------------------------------------------------- bookings

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
  platform: Platform;
  source: string;
  status: BookingStatus;
  priceUsd: number;
  /** Order or project id on the platform. */
  platformRef?: string;
  url?: string;
  escrowId?: string;
  /** Automatic replies to the freelancer are suspended. */
  paused: boolean;
  note?: string;
  createdAt: Ms;
  updatedAt: Ms;
}

/** A booking request handed to a source once escrow and approval are in place. */
export interface BookingRequest {
  bookingId: string;
  profile: FreelancerProfile;
  brief: Brief;
  priceUsd: number;
  pricingIndex?: number;
}

export type BookingResult =
  | { kind: 'placed'; platformRef: string; url?: string }
  /** The platform needs a person to finish (e.g. click pay in the browser). */
  | { kind: 'handoff'; url: string; instructions: string; platformRef?: string };

export interface PlatformBookingStatus {
  status: Extract<BookingStatus, 'placed' | 'in_progress' | 'delivered' | 'in_revision' | 'completed' | 'cancelled'>;
  deliveryText?: string;
  deliveryUrls?: string[];
}

// --------------------------------------------------------- conversations

export type Party = 'hirer' | 'freelancer' | 'agent' | 'operator';

export interface ConversationMessage {
  id: string;
  jobId: string;
  bookingId?: string;
  /** Which thread: with the person hiring, or with the person hired. */
  thread: 'hirer' | 'freelancer';
  from: Party;
  text: string;
  /** Platform message id, for dedupe of inbound messages. */
  externalId?: string;
  createdAt: Ms;
}

export interface PlatformMessage {
  externalId: string;
  fromFreelancer: boolean;
  text: string;
  at: Ms;
}

// -------------------------------------------------------------- approvals

export type ActionClass =
  | 'routine_message'
  | 'first_contact'
  | 'book'
  | 'pay'
  | 'accept'
  | 'revise'
  | 'cancel'
  | 'extra';

export interface Approval {
  id: string;
  action: ActionClass;
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

// ----------------------------------------------------------------- escrow

export type EscrowStatus = 'awaiting_deposit' | 'funded' | 'released' | 'refunded' | 'failed';

/** The booking budget held for one booking. */
export interface EscrowRecord {
  id: string;
  bookingId: string;
  provider: string;
  status: EscrowStatus;
  /** Token units as a decimal number, e.g. 25.5 USDC. */
  amount: number;
  currency: string;
  /** Where the payer sends funds. */
  address?: string;
  /** Unique key used to find the deposit on chain. */
  reference?: string;
  /** Wallet deep link (Solana Pay URL). */
  payUrl?: string;
  payer?: string;
  depositTx?: string;
  settleTx?: string;
  explorerUrl?: string;
  error?: string;
  createdAt: Ms;
  updatedAt: Ms;
}

// ----------------------------------------------------------------- events

export type HaasEvent =
  | { type: 'job.updated'; job: Job }
  | { type: 'job.progress'; jobId: string; message: string }
  | { type: 'shortlist.ready'; job: Job; shortlist: Shortlist }
  | { type: 'booking.updated'; booking: Booking }
  | { type: 'escrow.updated'; escrow: EscrowRecord }
  | { type: 'approval.requested'; approval: Approval }
  | { type: 'approval.resolved'; approval: Approval }
  | { type: 'conversation.message'; message: ConversationMessage }
  /** A person must act outside the app, e.g. solve a challenge in the browser. */
  | { type: 'operator.attention'; source: string; message: string; url?: string };
