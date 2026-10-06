import express from 'express';
import { createLiaison } from './agent/liaison';
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
import { createEscrowProvider } from './payments';
import { mountSolanaPay } from './payments/solana-pay';
import { mountX402 } from './payments/x402';
import { createRouter } from './router/router';
import { createSuitabilityScorer } from './router/suitability';
import { sokosumiWorkerFromConfig } from './sokosumi/setup';
import { createBrowserSources } from './sources/browser';
import { createFakeSource } from './sources/fake';
import { createFreelancerSource } from './sources/freelancer';
import { createProlificSource } from './sources/prolific';
import { createRegistry } from './sources/registry';
import { createRentAHumanSource } from './sources/rentahuman';
import { createUpworkSource } from './sources/upwork';

const config = loadConfig();
const store = createStore(config.DB_PATH);
const bus = createEventBus();

const sources: FreelancerSource[] = [
  createFreelancerSource(config),
  createRentAHumanSource(config),
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
const router = createRouter({ registry, suitability, bus, config });

const policy = createPolicy({ store, config });
const gate = createApprovalGate({ store, bus, policy, config });
const escrow = createEscrowProvider({ store, config });
const bookings = createBookingService({ store, bus, registry, escrow, gate, config });
const delegate = createDelegator({ config, bus, classifier: createClassifier({ config }), buyer: createBuyer(config) });
const jobs = createJobService({ store, bus, router, bookings, config, delegate });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/health', (_req, res) => {
  res.json({ ok: true, sources: registry.all().map((s) => ({ name: s.name, kind: s.kind, enabled: s.isEnabled() })) });
});

bounty.mount(app);
const masumi = mountMasumi(app, { jobs, store, bus, config });
mountX402(app, { jobs, store, bus, config });
// Solana Pay transaction requests for program escrow deposits (the hirer's wallet signs the deposit).
if (escrow.buildDepositTransaction) mountSolanaPay(app, { store, escrow, config });

const telegram = createTelegram({ jobs, bookings, gate, policy, store, bus, config });
const liaison = createLiaison({ store, bus, registry, gate, config });
const poller = createPoller({
  jobs: () => jobs.tick(),
  bookings: () => bookings.tick(),
  liaison: () => liaison.tick(),
  bounties: () => bounty.tick(),
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
  console.log(`[haas] listening on ${config.PUBLIC_URL} (port ${config.PORT})`);
  console.log(`[haas] sources: ${registry.enabled().map((s) => s.name).join(', ') || 'none enabled'}`);
  if (config.DEMO_MODE) console.log(`[haas] demo mode: pinned cache, ${config.DEMO_BUDGET_MS} ms budget (warm it with pnpm demo:warm)`);
  console.log(`[haas] AI-first: ${config.AI_DELEGATION}; agent: ${config.AI_AGENT_URL ?? (config.MASUMI_REGISTRY_URL ? 'registry search' : 'none')}`);
  console.log(`[haas] escrow: ${escrow.name}; masumi payments: ${config.MASUMI_API_KEY ? 'on' : 'off'}; x402: ${config.X402_PAY_TO || config.X402_SOLANA_PAY_TO ? 'on' : 'off'}`);
});
masumi.start();
const sokosumi = sokosumiWorkerFromConfig({ config, store, jobs });
sokosumi?.start();
poller.start();
telegram.start().catch((err) => console.error('[telegram] failed to start:', err));

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  poller.stop();
  bounty.stop();
  masumi.stop();
  sokosumi?.stop();
  await telegram.stop().catch(() => {});
  server.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
