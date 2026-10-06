// The whole pitch flow in one process, wired like src/index.ts but with loopback fakes for every
// outside service: the Masumi payment service (seller side), a Masumi AI seller agent, an on-chain
// style escrow, a Cardano chain (CIP-68) and a KERIA agent (Veridian). No network beyond 127.0.0.1.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createApprovalGate } from '../approvals/gate';
import { createPolicy } from '../approvals/policy';
import { bindBountyWallets, bountyWorkerOf } from '../bounty/identity';
import { createBountyModule } from '../bounty/index';
import type { WorkerInput } from '../bounty/board';
import { testConfig, type Config } from '../config';
import { createStore } from '../db/db';
import { createClassifier } from '../delegate/classify';
import { createDelegator } from '../delegate/delegate';
import { createEventBus } from '../domain/events';
import { newId } from '../domain/ids';
import type { EscrowProvider } from '../domain/ports';
import type { EscrowRecord, HaasEvent } from '../domain/types';
import { createBookingService } from '../engine/bookings';
import { createJobService } from '../engine/jobs';
import { createMemoryChain } from '../identity/chain';
import { createIdentity } from '../identity/index';
import { createFakeKeria } from '../identity/veridian/fake';
import { createVeridianCredentialIssuer } from '../identity/veridian/issuer';
import { combineSignals, createVeridianService } from '../identity/veridian/service';
import { mountMasumi } from '../masumi/api';
import { createBuyer } from '../masumi/buyer';
import { createRouter } from '../router/router';
import { createSuitabilityScorer } from '../router/suitability';
import { createRegistry } from '../sources/registry';
import type { RubricJudge } from '../verify/rubric';
import { createResultVerifier } from '../verify/verifier';

const servers: Server[] = [];
export const listen = (app: express.Express) =>
  new Promise<{ url: string; server: Server }>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      servers.push(s);
      resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, server: s });
    });
  });
export const closeAll = () => Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));

/** The seller side of the Masumi payment service: one payment whose on-chain state the test drives. */
export async function fakeSellerPayments() {
  const log: { path: string; body: any }[] = [];
  const state = { onChainState: null as string | null, resultHash: null as string | null, created: 0 };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => (log.push({ path: req.path, body: req.body }), next()));
  app.get('/registry/agent-identifier', (_req, res) =>
    res.json({ status: 'success', data: { supportedPaymentSources: [{ chain: 'Cardano', network: 'Preprod', paymentSourceType: 'Web3CardanoV2', address: 'addr_test1contract', pricing: { pricingType: 'Dynamic' } }] } }),
  );
  app.post('/payment', (req, res) => {
    const b = req.body;
    state.created++;
    res.json({
      status: 'success',
      data: {
        blockchainIdentifier: `bc_${state.created}`,
        payByTime: String(Date.parse(b.payByTime)),
        submitResultTime: String(Date.parse(b.submitResultTime)),
        unlockTime: String(Date.parse(b.unlockTime)),
        externalDisputeUnlockTime: String(Date.parse(b.externalDisputeUnlockTime)),
        onChainState: null,
        RequestedFunds: b.RequestedFunds ?? [],
        PaymentSource: { network: 'Preprod', paymentSourceType: 'Web3CardanoV2', smartContractAddress: 'addr_test1contract', policyId: 'p'.repeat(56) },
        SmartContractWallet: { walletVkey: 'vkey_seller', walletAddress: 'addr' },
        NextAction: { requestedAction: 'WaitingForExternalAction', errorType: null },
      },
    });
  });
  app.post('/payment/resolve-blockchain-identifier', (req, res) =>
    res.json({
      status: 'success',
      data: { blockchainIdentifier: req.body.blockchainIdentifier, onChainState: state.onChainState, resultHash: state.resultHash, NextAction: { requestedAction: 'None', errorType: null }, CurrentTransaction: null, TransactionHistory: [] },
    }),
  );
  app.post('/payment/submit-result', (req, res) => {
    state.resultHash = req.body.submitResultHash;
    res.json({ status: 'success', data: { blockchainIdentifier: req.body.blockchainIdentifier } });
  });
  const { url } = await listen(app);
  return { url, log, state };
}

/**
 * Stands in for the haas-escrow program: the hirer's deposit lands at once (as after signing the
 * Solana Pay request), release records the result hash and pays the payee, refund returns it.
 */
export function fakeProgramEscrow(now: () => number) {
  const releases: { bookingId: string; payee?: string; resultHash?: string; amount: number }[] = [];
  const refunds: { bookingId: string; amount: number }[] = [];
  const provider: EscrowProvider = {
    name: 'fake-program',
    currency: 'USDC',
    async create({ bookingId, amountUsd, payee, deadline }) {
      const t = now();
      return { id: newId('esc'), bookingId, provider: 'fake-program', status: 'funded', amount: amountUsd, currency: 'USDC', payer: 'HirerWa11et', payee, deadline, depositTx: `dep_${bookingId}`, createdAt: t, updatedAt: t };
    },
    refresh: async (e) => e,
    async release(e: EscrowRecord, opts = {}) {
      if (e.status !== 'funded') throw new Error(`release of a ${e.status} escrow`);
      if (e.deadline && now() >= e.deadline) throw new Error('program: deadline passed, refund only');
      releases.push({ bookingId: e.bookingId, payee: e.payee, resultHash: opts.resultHash, amount: e.amount });
      return { ...e, status: 'released', resultHash: opts.resultHash, settleTx: `rel_${e.bookingId}`, updatedAt: now() };
    },
    async refund(e: EscrowRecord) {
      if (e.status !== 'funded') throw new Error(`refund of a ${e.status} escrow`);
      refunds.push({ bookingId: e.bookingId, amount: e.amount });
      return { ...e, status: 'refunded', settleTx: `ref_${e.bookingId}`, updatedAt: now() };
    },
  };
  return { provider, releases, refunds };
}

export interface PitchStackOptions {
  config?: Partial<Config>;
  workers: WorkerInput[];
  /** QA rubric (stands in for the model). */
  rubric: RubricJudge;
  /** Approve or deny each approval request; default approves everything (the operator in Telegram). */
  decide?: (e: Extract<HaasEvent, { type: 'approval.requested' }>['approval']) => boolean;
}

export async function createPitchStack(opts: PitchStackOptions) {
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const config = testConfig({ PUBLIC_URL: 'http://haas.test', ANTHROPIC_API_KEY: 'test-key', VERIFY_TIMEOUT_MS: 2_000, ...opts.config });
  const store = createStore(':memory:');
  const bus = createEventBus();
  const events: HaasEvent[] = [];
  bus.on((e) => void events.push(e));

  const paid: string[] = [];
  const bounty = createBountyModule({
    store,
    bus,
    config,
    log: () => {},
    payout: { pay: async (w, b) => (paid.push(`${w.id}:${b.reward.amount}${b.reward.currency}`), { chain: 'solana', address: w.wallets.solana, ref: `ledger_${b.id}` }) },
  });
  for (const w of opts.workers) bounty.board.registerWorker(w);

  // Worker identity: Cardano CIP-68 on an in-memory chain, Veridian against an in-memory KERIA.
  const chain = createMemoryChain();
  const identity = createIdentity({ store, bus, config, chain, workerOf: (b) => bountyWorkerOf(bounty.board, b) })!;
  bindBountyWallets(bounty.board, identity.registry);
  const keria = createFakeKeria();
  const veridian = createVeridianService({ issuer: createVeridianCredentialIssuer(keria, { opTimeoutMs: 2_000 }), store, verifyTimeoutMs: 500, log: () => {} });

  const registry = createRegistry({ sources: [bounty.source], store, bus, config });
  const router = createRouter({ registry, suitability: createSuitabilityScorer({ store, config: { ...config, ANTHROPIC_API_KEY: undefined } }), bus, config, identity: combineSignals(identity.registry, veridian) });
  const policy = createPolicy({ store, config });
  const gate = createApprovalGate({ store, bus, policy, config });
  const escrow = fakeProgramEscrow(now);
  const verifier = createResultVerifier({ config, rubric: opts.rubric });
  const bookings = createBookingService({ store, bus, registry, escrow: escrow.provider, gate, config, verifier, now });
  const delegate = createDelegator({ config, bus, classifier: createClassifier({ config: { ...config, ANTHROPIC_API_KEY: undefined } }), buyer: createBuyer(config, { pollMs: 5, maxPollMs: 50 }) });
  const jobs = createJobService({ store, bus, router, bookings, config, delegate });

  // The operator answers approvals (a tap in Telegram in production).
  const asked: { action: string; summary: string; approved: boolean }[] = [];
  bus.on((e) => {
    if (e.type !== 'approval.requested') return;
    const approved = opts.decide ? opts.decide(e.approval) : true;
    asked.push({ action: e.approval.action, summary: e.approval.summary, approved });
    setTimeout(() => {
      if (store.getApproval(e.approval.id)?.status === 'pending') gate.resolve(e.approval.id, { approved, by: 'operator', ...(approved ? {} : { note: 'not what I asked for' }) });
    }, 0);
  });
  // Bounty changes reach the booking at once instead of on the next poll (as in src/index.ts).
  bus.on((e) => {
    if (e.type === 'bounty.updated') setTimeout(() => void bookings.tick().catch(() => {}), 5);
  });

  identity.start();
  const app = express();
  bounty.mount(app);
  const masumi = mountMasumi(app, { jobs, store, bus, config });
  const { url } = await listen(app);

  const call = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(url + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  return {
    url, call, config, store, bus, events, clock, bounty, identity, chain, veridian, keria, escrow, bookings, jobs, gate, asked, paid, masumi,
    stop() {
      identity.stop();
      bounty.stop();
      masumi.stop();
    },
  };
}
