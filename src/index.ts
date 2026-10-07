import express from 'express';
import { createLiaison } from './agent/liaison';
import { mountDashboard } from './api/dashboard';
import { createApprovalGate } from './approvals/gate';
import { createPolicy } from './approvals/policy';
import { createBountyModule } from './bounty';
import { createTelegram, registerTelegramExtension } from './channels/telegram';
import { loadConfig } from './config';
import { createStore } from './db/db';
import { createEventBus } from './domain/events';
import { createClassifier } from './delegate/classify';
import { createDelegator } from './delegate/delegate';
import type { FreelancerSource } from './domain/ports';
import { createBookingService } from './engine/bookings';
import { createJobService } from './engine/jobs';
import { createPoller } from './jobs/poller';
import { mountMasumi } from './masumi/api';
import { createBuyer } from './masumi/buyer';
import { createIdentity } from './identity';
import { bindBountyWallets, bountyWorkerOf } from './bounty/identity';
import { mountIdentity } from './identity/api';
import { createEscrowProvider } from './payments';
import { mountPayPage, mountSolanaPay } from './payments/solana-pay';
import { mountX402 } from './payments/x402';
import { createRouter } from './router/router';
import { createSuitabilityScorer } from './router/suitability';
import { sokosumiWorkerFromConfig } from './sokosumi/setup';
import { createBrowserSources } from './sources/browser';
import { createVeridian, mountVeridian } from './identity/veridian';
import { combineSignals } from './identity/veridian/service';
import { createFakeSource } from './sources/fake';
import { createFiverrSource } from './sources/fiverr';
import { createFreelancerSource } from './sources/freelancer';
import { createProlificSource } from './sources/prolific';
import { createRegistry } from './sources/registry';
import { createRentAHumanSource } from './sources/rentahuman';
import { createUpworkSource } from './sources/upwork';

const config = loadConfig();
const store = createStore(config.DB_PATH);
const bus = createEventBus();

// Human workers: RentAHuman, Fiverr, Freelancer.com, PeoplePerHour and Guru (+ Upwork/Prolific with keys).
const sources: FreelancerSource[] = [
  createRentAHumanSource(config),
  createFiverrSource({ config, bus }),
  createFreelancerSource(config),
  createUpworkSource(config),
  // Publishing a study spends money: it asks the approval gate, created further down.
  createProlificSource({ config, store, gate: () => gate }),
  ...createBrowserSources({ config, bus }),
];
// Fixtures only on request (or on stage, as an always-warm floor), so they never mix into real results.
if (config.DEMO_MODE || config.SOURCES?.split(',').map((s) => s.trim()).includes('fake')) sources.push(createFakeSource());
// First-party bounty board: enabled once verified workers are registered (scripts/seed-workers.ts).
const bounty = createBountyModule({ store, bus, config });
sources.push(bounty.source);
registerTelegramExtension(bounty.telegram);

const registry = createRegistry({ sources, store, bus, config });
const suitability = createSuitabilityScorer({ store, config });
// Worker credential and on-chain reputation (Cardano); null without BLOCKFROST_PROJECT_ID + CARDANO_MINT_MNEMONIC.
const identity = createIdentity({ store, bus, config, workerOf: (b) => bountyWorkerOf(bounty.board, b) });
// Bounty workers' Cardano wallets receive their credential and reputation (bound once, never overwritten).
if (identity) bindBountyWallets(bounty.board, identity.registry);
// Veridian (KERI ACDC) verified-worker credentials; null without KERIA settings.
const veridian = createVeridian({ config, store });
// Both feed one cache-only signal per worker: router boost and the 'verified' label.
const signals = identity || veridian ? combineSignals(identity?.registry, veridian) : undefined;
const router = createRouter({ registry, suitability, bus, config, ...(signals ? { identity: signals } : {}) });

const policy = createPolicy({ store, config });
const gate = createApprovalGate({ store, bus, policy, config });
if (!config.TELEGRAM_OPERATOR_ID && !config.TELEGRAM_BOT_TOKEN && !config.MANUAL_APPROVALS) {
  console.warn(
    '[approvals] HEADLESS MODE: every approval (booking, outreach, release) is auto-granted.\n' +
    '[approvals] Fine for local rehearsal; for anything real set TELEGRAM_BOT_TOKEN + TELEGRAM_OPERATOR_ID, or MANUAL_APPROVALS=true.',
  );
}
const escrow = createEscrowProvider({ store, config });
const bookings = createBookingService({ store, bus, registry, escrow, gate, config });
const delegate = createDelegator({ config, bus, classifier: createClassifier({ config }), buyer: createBuyer(config) });
const jobs = createJobService({ store, bus, router, bookings, config, delegate });
if (!config.AI_AGENT_URL && !config.MASUMI_REGISTRY_URL) {
  console.warn(
    '[delegate] AI-FIRST HAS NO AGENT SOURCE: every job goes straight to humans.\n' +
    "[delegate] Set AI_AGENT_URL (a MIP-003 agent's base URL, e.g. pnpm demo:agent on :8790) or MASUMI_REGISTRY_URL to hire fellow agents first.",
  );
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/health', (_req, res) => {
  const active = new Set(registry.enabled().map((s) => s.name));
  res.json({ ok: true, sources: registry.all().map((s) => ({ name: s.name, kind: s.kind, enabled: active.has(s.name) })) });
});

bounty.mount(app);
const masumi = mountMasumi(app, { jobs, store, bus, config });
mountX402(app, { jobs, store, bus, config });
const dashboard = mountDashboard(app, { jobs, bookings, gate, registry, store, bus, config });
// Solana Pay transaction requests for program escrow deposits (the hirer's wallet signs the deposit).
if (escrow.buildDepositTransaction) mountSolanaPay(app, { store, escrow, config });
// /pay/<bookingId>: the hirer's "open in wallet" page linked from the chat (any escrow provider).
mountPayPage(app, { store, config });
mountIdentity(app, identity);
mountVeridian(app, veridian, { publicUrl: config.PUBLIC_URL, ...(config.VERIDIAN_OOBI_BASE_URL ? { oobiBaseUrl: config.VERIDIAN_OOBI_BASE_URL } : {}), verifyTimeoutMs: config.VERIDIAN_VERIFY_TIMEOUT_MS, ...(config.VERIDIAN_ADMIN_TOKEN ? { adminToken: config.VERIDIAN_ADMIN_TOKEN } : {}) });

// Body-parser and other middleware errors must answer in the API's JSON shape,
// not Express's default HTML page with a stack trace.
app.use((err: Error & { type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'invalid JSON body' });
  console.error('[http] unhandled error:', err.message);
  res.status(500).json({ error: 'internal error' });
});

const telegram = createTelegram({ jobs, bookings, gate, policy, store, bus, config, registry });
const liaison = createLiaison({ store, bus, registry, gate, config });
const poller = createPoller({
  jobs: () => jobs.tick(),
  bookings: () => bookings.tick(),
  liaison: () => liaison.tick(),
  bounties: async () => {
    // Workers registered while running (pnpm seed:workers) get their identity wallet too.
    if (identity) bindBountyWallets(bounty.board, identity.registry);
    await bounty.tick();
  },
});
// Bounty state changes (claim, submit, expiry) reach the booking at once instead of on the next poll.
let bountyKick: ReturnType<typeof setTimeout> | undefined;
bus.on((e) => {
  if (e.type !== 'bounty.updated' || bountyKick) return;
  bountyKick = setTimeout(() => {
    bountyKick = undefined;
    bookings.tick().catch((err) => console.error('[bounty] booking refresh failed:', err));
  }, 250);
});

const server = app.listen(config.PORT, () => {
  console.log(`[haas] listening on http://localhost:${config.PORT} (public URL: ${config.PUBLIC_URL})`);
  console.log(`[haas] sources: ${registry.enabled().map((s) => s.name).join(', ') || 'none enabled'}`);
  if (config.DEMO_MODE) console.log(`[haas] demo mode: pinned cache, ${config.DEMO_BUDGET_MS} ms budget (warm it with pnpm demo:warm)`);
  console.log(`[haas] AI-first: always (write "human only" to skip agents); agent: ${config.AI_AGENT_URL ?? (config.MASUMI_REGISTRY_URL ? 'registry search' : 'none')}`);
  console.log(`[haas] escrow: ${escrow.name}; masumi payments: ${config.MASUMI_API_KEY ? (config.MASUMI_AGENT_IDENTIFIER ? 'on' : 'partial (set MASUMI_AGENT_IDENTIFIER)') : 'off'}; x402: ${config.X402_PAY_TO || config.X402_SOLANA_PAY_TO ? 'on' : 'off'}; identity: ${identity ? config.CARDANO_NETWORK : 'off'}`);
  // After listen: KERIA resolves the schema OOBI from this server.
  veridian?.issuer
    .init()
    .then(({ issuerAid }) => console.log(`[haas] veridian issuer ${issuerAid}`))
    .catch((err) => console.error('[veridian] issuer not ready (retried on first use):', (err as Error).message));
});
veridian?.startPolling();
masumi.start();
const sokosumi = sokosumiWorkerFromConfig({ config, store, jobs });
sokosumi?.start();
poller.start();
identity?.start();
telegram.start().catch((err) => console.error('[telegram] failed to start:', err));

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  poller.stop();
  bounty.stop();
  veridian?.stop();
  masumi.stop();
  dashboard.stop();
  sokosumi?.stop();
  identity?.stop();
  await telegram.stop().catch(() => {});
  server.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
