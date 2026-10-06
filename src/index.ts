import express from 'express';
import { createLiaison } from './agent/liaison';
import { createApprovalGate } from './approvals/gate';
import { createPolicy } from './approvals/policy';
import { createTelegram } from './channels/telegram';
import { loadConfig } from './config';
import { createStore } from './db/db';
import { createEventBus } from './domain/events';
import type { FreelancerSource } from './domain/ports';
import { createBookingService } from './engine/bookings';
import { createJobService } from './engine/jobs';
import { createPoller } from './jobs/poller';
import { mountMasumi } from './masumi/api';
import { createEscrowProvider } from './payments';
import { mountX402 } from './payments/x402';
import { createRouter } from './router/router';
import { createSuitabilityScorer } from './router/suitability';
import { sokosumiWorkerFromConfig } from './sokosumi/setup';
import { createBrowserSources } from './sources/browser';
import { createFakeSource } from './sources/fake';
import { createFreelancerSource } from './sources/freelancer';
import { createRegistry } from './sources/registry';
import { createRentAHumanSource } from './sources/rentahuman';

const config = loadConfig();
const store = createStore(config.DB_PATH);
const bus = createEventBus();

const sources: FreelancerSource[] = [
  createFreelancerSource(config),
  createRentAHumanSource(config),
  ...createBrowserSources({ config, bus }),
];
// Fixtures only on request (or on stage, as an always-warm floor), so they never mix into real results.
if (config.DEMO_MODE || config.SOURCES?.split(',').map((s) => s.trim()).includes('fake')) sources.push(createFakeSource());

const registry = createRegistry({ sources, store, bus, config });
const suitability = createSuitabilityScorer({ store, config });
const router = createRouter({ registry, suitability, bus, config });

const policy = createPolicy({ store, config });
const gate = createApprovalGate({ store, bus, policy, config });
const escrow = createEscrowProvider({ store, config });
const bookings = createBookingService({ store, bus, registry, escrow, gate, config });
const jobs = createJobService({ store, bus, router, bookings, config });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/health', (_req, res) => {
  res.json({ ok: true, sources: registry.all().map((s) => ({ name: s.name, kind: s.kind, enabled: s.isEnabled() })) });
});

const masumi = mountMasumi(app, { jobs, store, bus, config });
mountX402(app, { jobs, store, bus, config });

const telegram = createTelegram({ jobs, bookings, gate, policy, store, bus, config });
const liaison = createLiaison({ store, bus, registry, gate, config });
const poller = createPoller({
  jobs: () => jobs.tick(),
  bookings: () => bookings.tick(),
  liaison: () => liaison.tick(),
});

const server = app.listen(config.PORT, () => {
  console.log(`[haas] listening on ${config.PUBLIC_URL} (port ${config.PORT})`);
  console.log(`[haas] sources: ${registry.enabled().map((s) => s.name).join(', ') || 'none enabled'}`);
  if (config.DEMO_MODE) console.log(`[haas] demo mode: pinned cache, ${config.DEMO_BUDGET_MS} ms budget (warm it with pnpm demo:warm)`);
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
  masumi.stop();
  sokosumi?.stop();
  await telegram.stop().catch(() => {});
  server.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
