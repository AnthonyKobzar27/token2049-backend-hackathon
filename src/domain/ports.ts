// Interfaces between modules, and the factory each module exports.
// This file is a contract: do not change it from inside a module; raise the need instead.

import type { Express } from 'express';
import type { Config } from '../config';
import type {
  ActionClass,
  Approval,
  Booking,
  BookingRequest,
  BookingResult,
  BookingStatus,
  Brief,
  Candidate,
  ConversationMessage,
  EscrowRecord,
  FreelancerProfile,
  HaasEvent,
  Job,
  JobClient,
  JobStatus,
  Platform,
  PlatformBookingStatus,
  PlatformMessage,
  Shortlist,
  SourceStatus,
  SuitabilityScore,
  UserInput,
} from './types';

// ------------------------------------------------------------------ events

export interface EventBus {
  emit(event: HaasEvent): void;
  /** Returns an unsubscribe function. Handlers must not throw. */
  on(handler: (event: HaasEvent) => void): () => void;
}

// ------------------------------------------------------------------- store
// Implemented in src/db/db.ts as `createStore(dbPath: string): Store` (node:sqlite).
// All methods are synchronous. Objects are stored whole (JSON) with indexed key columns.

export interface Store {
  insertJob(job: Job): void;
  /** Merges the patch, bumps updatedAt, returns the stored job. Throws if missing. */
  updateJob(id: string, patch: Partial<Job>): Job;
  getJob(id: string): Job | null;
  listJobs(filter?: { status?: JobStatus; client?: JobClient; clientRef?: string }): Job[];

  insertShortlist(shortlist: Shortlist): void;
  getShortlist(id: string): Shortlist | null;
  latestShortlist(jobId: string): Shortlist | null;
  listShortlists(jobId: string): Shortlist[];

  /** Profile cache, keyed by source and a normalised query key. */
  putProfiles(source: string, queryKey: string, profiles: FreelancerProfile[]): void;
  getCachedProfiles(source: string, queryKey: string, maxAgeMs: number): FreelancerProfile[] | null;
  getProfile(id: string): FreelancerProfile | null;

  getSuitability(briefKey: string, profileId: string): SuitabilityScore | null;
  putSuitability(briefKey: string, profileId: string, score: SuitabilityScore): void;

  insertBooking(booking: Booking): void;
  updateBooking(id: string, patch: Partial<Booking>): Booking;
  getBooking(id: string): Booking | null;
  listBookings(filter?: { status?: BookingStatus[]; jobId?: string }): Booking[];

  /** Ignores a message whose (bookingId, externalId) already exists; returns false then. */
  addMessage(message: ConversationMessage): boolean;
  listMessages(filter: { jobId?: string; bookingId?: string; thread?: 'hirer' | 'freelancer' }): ConversationMessage[];

  insertApproval(approval: Approval): void;
  updateApproval(id: string, patch: Partial<Approval>): Approval;
  getApproval(id: string): Approval | null;
  listApprovals(filter?: { status?: Approval['status'] }): Approval[];

  insertEscrow(escrow: EscrowRecord): void;
  updateEscrow(id: string, patch: Partial<EscrowRecord>): EscrowRecord;
  getEscrow(id: string): EscrowRecord | null;
  getEscrowByBooking(bookingId: string): EscrowRecord | null;
  listEscrows(filter?: { status?: EscrowRecord['status'][] }): EscrowRecord[];

  /** Small key-value store for module state (cursors, tokens). */
  getKv(key: string): string | null;
  setKv(key: string, value: string): void;

  close(): void;
}

// ----------------------------------------------------------------- sources

export interface SearchOptions {
  /** Maximum profiles to return. */
  limit: number;
  signal?: AbortSignal;
}

/** One freelancer platform. Search is required; everything else is optional. */
export interface FreelancerSource {
  /** Unique, e.g. "freelancer", "fiverr". */
  readonly name: string;
  readonly platform: Platform;
  readonly kind: 'api' | 'browser' | 'fixture';
  /** False when credentials or prerequisites are missing; the registry then skips it. */
  isEnabled(): boolean;

  search(brief: Brief, opts: SearchOptions): Promise<FreelancerProfile[]>;
  getProfile?(platformId: string): Promise<FreelancerProfile | null>;

  /**
   * Binding. Called only by the booking service after escrow is funded and the
   * 'book' approval was granted. Must never complete a payment itself when the
   * platform needs a card: return a handoff instead.
   */
  book?(request: BookingRequest): Promise<BookingResult>;
  getBookingStatus?(platformRef: string): Promise<PlatformBookingStatus>;
  sendMessage?(platformRef: string, text: string): Promise<void>;
  readMessages?(platformRef: string, since: number): Promise<PlatformMessage[]>;
  acceptDelivery?(platformRef: string): Promise<void>;
  requestRevision?(platformRef: string, text: string): Promise<void>;
}

/** src/sources/registry.ts: `createRegistry(deps: { sources: FreelancerSource[]; store: Store; bus: EventBus; config: Config }): SourceRegistry` */
export interface SourceRegistry {
  all(): FreelancerSource[];
  enabled(): FreelancerSource[];
  get(name: string): FreelancerSource | undefined;
  /**
   * Queries every enabled source in parallel with a per-source timeout
   * (config.SOURCE_TIMEOUT_MS), using the profile cache (config.PROFILE_CACHE_TTL_MIN).
   * A failing source yields a SourceStatus with ok=false and, when available,
   * stale cached profiles; it never rejects the whole search.
   */
  searchAll(brief: Brief, opts: { limitPerSource: number; jobId?: string }): Promise<{ profiles: FreelancerProfile[]; sources: SourceStatus[] }>;
}

// ------------------------------------------------------------------ router

/** src/router/suitability.ts: `createSuitabilityScorer(deps: { store: Store; config: Config }): SuitabilityScorer` */
export interface SuitabilityScorer {
  /** Scores every profile against the brief. Cached per (brief, profile). Returns a map by profile id; missing entries mean unknown. */
  score(brief: Brief, profiles: FreelancerProfile[]): Promise<Map<string, SuitabilityScore>>;
}

/** src/router/router.ts: `createRouter(deps: { registry: SourceRegistry; suitability: SuitabilityScorer; bus: EventBus; config: Config }): Router` */
export interface Router {
  /** Fan out, normalise, hard-filter, score, explain. `exclude` are profile ids already rejected in earlier rounds. */
  route(brief: Brief, opts: { jobId?: string; limit: number; exclude?: string[]; feedback?: string }): Promise<{ candidates: Candidate[]; sources: SourceStatus[] }>;
}

// -------------------------------------------------------------------- jobs

/** src/engine/jobs.ts: `createJobService(deps: { store: Store; bus: EventBus; router: Router; bookings: BookingService; config: Config }): JobService` */
export interface JobService {
  /**
   * Creates a job. With awaitPayment the job starts in 'awaiting_payment' and
   * routing begins on markPaid; otherwise routing starts at once (status 'running').
   * Routing runs in the background; the call returns immediately.
   */
  startJob(input: { brief: Brief; client: JobClient; clientRef?: string; awaitPayment?: boolean; id?: string }): Job;
  markPaid(jobId: string): void;
  getJob(id: string): Job | null;
  getShortlist(jobId: string): Shortlist | null;
  /**
   * Answers a check-in. Only valid in 'awaiting_input'.
   * confirm -> creates a booking, job 'running' until the booking is placed or handed off, then 'completed'.
   * refine  -> new routing round excluding earlier candidates, back to 'awaiting_input'.
   * cancel  -> 'completed' with outcome 'no_booking'.
   */
  provideInput(jobId: string, input: UserInput): Job;
  /** Resumes in-flight jobs after a restart, and expires unanswered check-ins. Called on boot and by the poller. */
  tick(): Promise<void>;
}

// ---------------------------------------------------------------- bookings

/** src/engine/bookings.ts: `createBookingService(deps: { store: Store; bus: EventBus; registry: SourceRegistry; escrow: EscrowProvider; gate: ApprovalGate; config: Config }): BookingService` */
export interface BookingService {
  /**
   * pending_escrow -> (deposit seen) escrowed -> awaiting_approval ('book' approval)
   * -> source.book() -> placed | handoff. Sources without book() go straight to
   * 'handoff' with the profile URL. Runs in the background; returns the new booking.
   */
  create(job: Job, candidate: Candidate): Booking;
  get(id: string): Booking | null;
  /** Each asks the approval gate first, then calls the source, then settles escrow. */
  accept(id: string): Promise<Booking>;
  requestRevision(id: string, text: string): Promise<Booking>;
  cancel(id: string, reason: string): Promise<Booking>;
  /** Polls escrow deposits and platform status for open bookings. */
  tick(): Promise<void>;
}

// --------------------------------------------------------------- approvals

/** src/approvals/gate.ts: `createApprovalGate(deps: { store: Store; bus: EventBus; policy: AutonomyPolicy; config: Config }): ApprovalGate` */
export interface ApprovalGate {
  /**
   * Resolves at once with approved=true when the policy makes the action automatic.
   * Otherwise stores a pending Approval, emits 'approval.requested', and resolves
   * when resolve() is called or the timeout passes (then approved=false).
   */
  request(req: { action: ActionClass; jobId?: string; bookingId?: string; summary: string; detail?: string; timeoutMs?: number }): Promise<{ approved: boolean; approval?: Approval }>;
  /** Called by the channel when the operator taps approve or deny. */
  resolve(approvalId: string, decision: { approved: boolean; by: string; note?: string }): void;
}

/** src/approvals/policy.ts: `createPolicy(deps: { store: Store; config: Config }): AutonomyPolicy` */
export interface AutonomyPolicy {
  /** Only 'routine_message' may be automatic, and only while the booking is not paused. */
  requiresApproval(action: ActionClass, bookingId?: string): boolean;
  pause(bookingId: string): void;
  resume(bookingId: string): void;
}

// ------------------------------------------------------------------ escrow

/**
 * The booking budget. src/payments/index.ts:
 * `createEscrowProvider(deps: { store: Store; config: Config }): EscrowProvider`
 * returns the Solana provider when config.ESCROW_PROVIDER === 'solana', else the memory one.
 * Providers do not write to the store; the booking service persists what they return.
 */
export interface EscrowProvider {
  readonly name: string;
  readonly currency: string;
  /** Prepares a deposit target for this booking. Status 'awaiting_deposit' (memory provider: 'funded'). */
  create(input: { bookingId: string; amountUsd: number }): Promise<EscrowRecord>;
  /** Re-reads chain state; moves 'awaiting_deposit' to 'funded' when the full amount has arrived. */
  refresh(escrow: EscrowRecord): Promise<EscrowRecord>;
  /** Pays the operator wallet. */
  release(escrow: EscrowRecord): Promise<EscrowRecord>;
  /** Returns funds to the payer. */
  refund(escrow: EscrowRecord): Promise<EscrowRecord>;
}

// ----------------------------------------------------- module entry points

export interface ApiDeps {
  jobs: JobService;
  store: Store;
  bus: EventBus;
  config: Config;
}

/** src/masumi/api.ts: `mountMasumi(app: Express, deps: ApiDeps): { start(): void; stop(): void }` mounts MIP-003 routes and runs the payment watcher. */
export type MountMasumi = (app: Express, deps: ApiDeps) => { start(): void; stop(): void };

/** src/payments/x402.ts: `mountX402(app: Express, deps: ApiDeps): void` mounts POST /x402/route behind the Cardano paywall. */
export type MountX402 = (app: Express, deps: ApiDeps) => void;

export interface DashboardApiDeps {
  jobs: JobService;
  bookings: BookingService;
  gate: ApprovalGate;
  registry: SourceRegistry;
  store: Store;
  bus: EventBus;
  config: Config;
}

/** src/api/dashboard.ts: `mountDashboard(app: Express, deps: DashboardApiDeps): { stop(): void }` mounts /api/* (REST + SSE) for the web dashboard and the iMessage bridge. */
export type MountDashboard = (app: Express, deps: DashboardApiDeps) => { stop(): void };

export interface TelegramDeps {
  jobs: JobService;
  bookings: BookingService;
  gate: ApprovalGate;
  policy: AutonomyPolicy;
  store: Store;
  bus: EventBus;
  config: Config;
}

/** src/channels/telegram.ts: `createTelegram(deps: TelegramDeps): { start(): Promise<void>; stop(): Promise<void> }` */
export type CreateTelegram = (deps: TelegramDeps) => { start(): Promise<void>; stop(): Promise<void> };

export interface LiaisonDeps {
  store: Store;
  bus: EventBus;
  registry: SourceRegistry;
  gate: ApprovalGate;
  config: Config;
}

/** src/agent/liaison.ts: `createLiaison(deps: LiaisonDeps): { tick(): Promise<void> }` reads new platform messages for open bookings and replies or relays. */
export type CreateLiaison = (deps: LiaisonDeps) => { tick(): Promise<void> };
