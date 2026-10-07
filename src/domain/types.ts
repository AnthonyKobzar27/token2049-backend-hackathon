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
  /** First-party microtask board: HAAS's own registered workers. */
  | 'bounty'
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
  /** When the work should happen (mostly for in-person tasks). Times are local to `when.timezone` (else `timezone`). */
  when?: BriefWhen;
  /** On-site only: how far from `location` the freelancer may be, in km. Default set by the router. */
  radiusKm?: number;
  /** Overrides the router's task-type inference, which picks the scoring weights. */
  taskType?: TaskType;
  /** What a correct delivery must contain; used by the result verifier (QA) before escrow is released. */
  expectedResult?: ExpectedResult;
}

/** One field a structured delivery must carry, e.g. a booking reference or an appointment time. */
export interface ExpectedField {
  name: string;
  type?: 'text' | 'number' | 'date' | 'time' | 'datetime' | 'url' | 'email' | 'reference' | 'boolean';
  /** Default true. */
  required?: boolean;
  /** Regular expression the value must match. */
  pattern?: string;
  description?: string;
}

export interface ExpectedResult {
  fields?: ExpectedField[];
  /** Plain acceptance criteria the rubric judges, e.g. "photo shows the shop front". */
  criteria?: string[];
}

/** A specific day and/or time window. */
export interface BriefWhen {
  /** YYYY-MM-DD. */
  date?: string;
  /** 24h "HH:MM" local times; end may be "24:00". */
  window?: { start: string; end: string };
  /** IANA zone the date and window are in. */
  timezone?: string;
}

export type TaskType = 'in_person' | 'remote_creative' | 'remote_technical' | 'remote_general';

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
  /** Weekly working windows in the profile's local time, keyed by lower-case English weekday ("monday"). */
  schedule?: Record<string, { start: string; end: string }[]>;
  /** The platform says the person is currently taking work. */
  accepting?: boolean;
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
  /** Solana wallet the freelancer accepts USDC at, when the platform publishes one. */
  solanaWallet?: string;
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
  /** Distance or place fit. Absent when the brief states no place preference. */
  location?: number | null;
  /** Fit for the brief's specific day and time window. Absent when the brief gives none. */
  timing?: number | null;
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
  /** Set when a HAAS credential is confirmed (Cardano CIP-68 and/or Veridian KERI): the 'verified' label. */
  identity?: { verified: true; by: Array<'cardano' | 'veridian'>; jobsCompleted: number; avgRating?: number };
}

export interface SourceStatus {
  source: string;
  ok: boolean;
  count: number;
  cached: boolean;
  ms: number;
  error?: string;
  /** Did not answer within the search budget; still running in the background to warm the cache. */
  late?: boolean;
  /** Served from an expired cache entry while a refresh runs in the background. */
  stale?: boolean;
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

/** On-chain settlement of a paid request (x402). */
export interface PaymentSettlement {
  protocol: 'x402';
  /** x402 network id, e.g. "cardano:preprod" or a Solana CAIP-2 id. */
  network: string;
  /** USDM | USDC | ADA */
  asset: string;
  /** Atomic units paid. */
  amount: string;
  /** Settlement transaction hash (Cardano) or signature (Solana). */
  transaction: string;
  explorerUrl?: string;
  payer?: string;
  settledAt: Ms;
}

/** Who did the work: a Masumi AI agent we hired, or a human found by the router. */
export type JobPath = 'ai' | 'human';

/** The Masumi AI agent that delivered a job on the AI path. */
export interface AiAgentWork {
  name: string;
  agentIdentifier?: string;
  apiBaseUrl: string;
  /** The job id on the hired agent's MIP-003 API. */
  jobId: string;
  identifierFromPurchaser: string;
  blockchainIdentifier?: string;
  /** Funds were locked through the buyer payment service (false in free/demo mode). */
  paid: boolean;
  /** The MIP-004 result hash matched; undefined when no hash was available to check. */
  verified?: boolean;
  ms: number;
}

export interface JobResult {
  outcome: 'booked' | 'handoff' | 'no_booking' | 'delivered';
  summary: string;
  path?: JobPath;
  /** AI path: the hired agent and its job. */
  agent?: AiAgentWork;
  /** AI path: the agent's full output. */
  output?: string;
  freelancer?: Pick<FreelancerProfile, 'id' | 'platform' | 'name' | 'url' | 'headline'>;
  priceUsd?: number;
  bookingId?: string;
  bookingRef?: string;
  bookingUrl?: string;
  /** QA-verified delivery: the hash the escrow release carries on chain, and what it hashes (MIP-004 style). */
  verifiedResult?: { hash: string; payload: string };
  /** How the job was paid, when it was paid over x402. */
  settlement?: PaymentSettlement;
  /** The work's own result, for tasks a person carries out (bounties): structured fields plus a one-line summary. */
  work?: { summary: string; data: Record<string, unknown>; urls?: string[] };
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
  /** x402 settlement of the job fee. */
  settlement?: PaymentSettlement;
  result?: JobResult;
  /** Set once the AI-or-human decision is made. */
  path?: JobPath;
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
  /** QA of a delivery is running. */
  | 'verifying'
  /** QA passed; waiting for the release approval. */
  | 'verified'
  /** QA failed after the one revision; no payout, escrow is refunded. */
  | 'rejected'
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
  /** Wallet the escrow pays on release; unset means the operator (who pays the platform in fiat). */
  payeeWallet?: string;
  /** Automatic replies to the freelancer are suspended. */
  paused: boolean;
  note?: string;
  /** What the freelancer delivered, as last reported by the platform. */
  delivery?: BookingDelivery;
  /** Latest QA report on the delivery. */
  verification?: VerificationReport;
  /** Hash of the verified result the escrow was released against (set on completion after QA). */
  resultHash?: string;
  createdAt: Ms;
  updatedAt: Ms;
}

export interface BookingDelivery {
  text?: string;
  /** One line a person can read, e.g. "Booked: Thursday 3pm, ref 88213". */
  summary?: string;
  /** Structured result, when the platform has one. */
  data?: Record<string, unknown>;
  urls?: string[];
  at: Ms;
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
  /** Structured delivery, e.g. a bounty result validated against its schema. */
  deliveryData?: Record<string, unknown>;
  /** One-line summary of the delivery. */
  deliverySummary?: string;
}

// ------------------------------------------------------------------- QA

/** What the freelancer handed over, as checked by the result verifier. */
export interface DeliveredResult {
  text?: string;
  urls?: string[];
  fields?: Record<string, unknown>;
}

export type VerificationVerdict = 'pass' | 'fail' | 'needs_human';

export interface VerificationCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** 'rule' for deterministic checks, 'llm' for rubric items, 'human' for the hirer's review. */
  by?: 'rule' | 'llm' | 'human';
}

export interface VerificationReport {
  verdict: VerificationVerdict;
  /** 0 to 1. */
  score: number;
  checks: VerificationCheck[];
  summary: string;
  /** MIP-004 style hash of the delivered result; the same value goes to Masumi and the escrow release. */
  resultHash: string;
  /** sha256 of the canonical delivery, to tell a new delivery from a re-read of the old one. */
  deliveryHash: string;
  /** 1 for the first QA run on this booking. */
  attempt: number;
  model?: string;
  ms: number;
  at: Ms;
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
  /** On-chain deadline: after it the escrow can only be refunded, by anyone. */
  deadline?: Ms;
  /** Wallet paid on release. */
  payee?: string;
  /** Hex sha256 of the verified delivery, recorded on chain at release. */
  resultHash?: string;
  /** Every transaction touching this escrow, oldest first. */
  txs?: EscrowTx[];
  createdAt: Ms;
  updatedAt: Ms;
}

export interface EscrowTx {
  kind: 'deposit' | 'release' | 'refund' | 'cancel';
  signature: string;
  /** Block explorer link. */
  url: string;
  at: Ms;
}

// ----------------------------------------------------------------- events

export type HaasEvent =
  | { type: 'job.updated'; job: Job }
  | { type: 'job.progress'; jobId: string; message: string }
  /** One source finished (or ran out of time) during a search. */
  | { type: 'source.done'; jobId?: string; status: SourceStatus }
  | { type: 'shortlist.ready'; job: Job; shortlist: Shortlist }
  | { type: 'booking.updated'; booking: Booking }
  | { type: 'escrow.updated'; escrow: EscrowRecord }
  /** A deadline passed: the deposit never came (booking cancelled) or the delivery never got accepted (budget refunded). */
  | { type: 'escrow.timeout'; kind: 'deposit_expired' | 'delivery_expired'; booking: Booking; escrow: EscrowRecord }
  | { type: 'approval.requested'; approval: Approval }
  | { type: 'approval.resolved'; approval: Approval }
  | { type: 'conversation.message'; message: ConversationMessage }
  | { type: 'verification.started'; bookingId: string; jobId: string; attempt: number }
  | { type: 'verification.completed'; booking: Booking; report: VerificationReport }
  /** QA failed and the freelancer was asked to fix the listed checks. */
  | { type: 'verification.revision_requested'; booking: Booking; report: VerificationReport; text: string }
  /** QA failed twice (or the hirer refused the redo): no payout, refund follows. */
  | { type: 'verification.rejected'; booking: Booking; report: VerificationReport }
  /** A person must act outside the app, e.g. solve a challenge in the browser. */
  | { type: 'operator.attention'; source: string; message: string; url?: string }
  /** A first-party bounty changed state. 'expired' carries the stage that timed out (escrow refunds on it). */
  | { type: 'bounty.updated'; bounty: BountyEvent }
  /** A completed job was recorded on the worker's Cardano credential (and a receipt NFT minted, when on). */
  | { type: 'reputation.recorded'; workerId: string; bookingId: string; jobId: string; txHash: string; receiptUnit?: string; jobsCompleted: number; avgRating?: number };

export type BountyStatus = 'posted' | 'claimed' | 'submitted' | 'verified' | 'paid' | 'rejected' | 'expired' | 'cancelled';

export interface BountyEvent {
  bountyId: string;
  bookingId?: string;
  jobId?: string;
  status: BountyStatus;
  workerId?: string;
  rewardUsd: number;
  /** Set when status is 'expired'. */
  stage?: 'claim' | 'submit';
  reason?: string;
  at: Ms;
}
