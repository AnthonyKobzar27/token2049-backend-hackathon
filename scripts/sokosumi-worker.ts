// Runs the Sokosumi Coworker worker on its own, without the HTTP API or Telegram.
//
//   pnpm sokosumi:worker --check   identity check: the key's Coworker, its READY Tasks, the payment settings
//   pnpm sokosumi:worker --once    one pass: pick up READY Tasks and move each as far as it can go now
//   pnpm sokosumi:worker --status  print the journal of every Task this worker has seen
//   pnpm sokosumi:worker           poll every SOKOSUMI_POLL_MS until Ctrl-C
//
// Needs SOKOSUMI_COWORKER_ID and SOKOSUMI_COWORKER_API_KEY (~/.haas/.env or the environment). Paid Tasks also
// need SOKOSUMI_PAID_TASKS=true, MASUMI_API_URL, MASUMI_API_KEY and MASUMI_AGENT_IDENTIFIER.
// Run only one worker per Coworker: stop the one inside `pnpm start` (unset SOKOSUMI_COWORKER_ID there) first.
import { createApprovalGate } from '../src/approvals/gate';
import { createPolicy } from '../src/approvals/policy';
import { loadConfig } from '../src/config';
import { createStore } from '../src/db/db';
import { createEventBus } from '../src/domain/events';
import type { FreelancerSource } from '../src/domain/ports';
import { createBookingService } from '../src/engine/bookings';
import { createJobService } from '../src/engine/jobs';
import { paymentsConfigured } from '../src/masumi/payments';
import { formatAmount, quoteFee } from '../src/masumi/pricing';
import { createEscrowProvider } from '../src/payments';
import { createRouter } from '../src/router/router';
import { createSuitabilityScorer } from '../src/router/suitability';
import { createCoreClient } from '../src/sokosumi/core';
import { sokosumiWorkerFromConfig } from '../src/sokosumi/setup';
import type { TaskRecord } from '../src/sokosumi/worker';
import { createBrowserSources } from '../src/sources/browser';
import { createFakeSource } from '../src/sources/fake';
import { createFreelancerSource } from '../src/sources/freelancer';
import { createRegistry } from '../src/sources/registry';
import { createRentAHumanSource } from '../src/sources/rentahuman';

const args = new Set(process.argv.slice(2));
const config = loadConfig();

if (!config.SOKOSUMI_COWORKER_ID || !config.SOKOSUMI_COWORKER_API_KEY) {
  console.error('Set SOKOSUMI_COWORKER_ID and SOKOSUMI_COWORKER_API_KEY (the coworker_* runtime key).');
  process.exit(1);
}

if (args.has('--check')) {
  const core = createCoreClient({ apiUrl: config.SOKOSUMI_API_URL, apiKey: config.SOKOSUMI_COWORKER_API_KEY });
  const me = await core.me();
  const ok = me.id === config.SOKOSUMI_COWORKER_ID && !me.archivedAt && me.capabilities.includes('tasks');
  console.log(`Sokosumi:        ${config.SOKOSUMI_API_URL}`);
  console.log(`Coworker:        ${me.id} capabilities=${me.capabilities.join(',')} ${ok ? 'OK' : 'MISMATCH: the key must belong to SOKOSUMI_COWORKER_ID, active, with tasks'}`);
  const ready = await core.listReadyTasks(config.SOKOSUMI_COWORKER_ID);
  console.log(`READY Tasks:     ${ready.length}${ready.map((t) => `\n  ${t.id}  ${t.organizationId ?? 'personal'}  ${t.name}`).join('')}`);
  console.log(`Workspace:       ${config.SOKOSUMI_ORGANIZATION_ID ?? 'every Workspace the Coworker has access to'}`);
  console.log(`Paid Tasks:      ${config.SOKOSUMI_PAID_TASKS}${config.SOKOSUMI_PAID_TASKS ? ` (${paymentsConfigured(config) ? 'payment service configured' : 'MISSING MASUMI_API_KEY / MASUMI_AGENT_IDENTIFIER'})` : ''}`);
  console.log(`Fee per Task:    ${formatAmount(quoteFee(undefined, config))}`);
  console.log(
    `Deadlines (min): pay ${config.SOKOSUMI_PAY_WINDOW_MIN}, result ${config.SOKOSUMI_RESULT_WINDOW_MIN}, unlock +${config.SOKOSUMI_UNLOCK_DELAY_MIN}, dispute +${config.SOKOSUMI_DISPUTE_DELAY_MIN}`,
  );
  process.exit(ok ? 0 : 1);
}

const store = createStore(config.DB_PATH);

if (args.has('--status')) {
  // The journal lives in the kv table under sokosumi:task:<id>; the open list names the ones still in flight.
  const open = JSON.parse(store.getKv('sokosumi:open') ?? '[]') as string[];
  for (const id of open) {
    const r = JSON.parse(store.getKv(`sokosumi:task:${id}`) ?? 'null') as TaskRecord | null;
    if (!r) continue;
    console.log(JSON.stringify({ ...r, result: r.result ? `${r.result.slice(0, 80)}...` : undefined }, null, 2));
  }
  if (!open.length) console.log('No Task in flight. Finished Tasks stay in the store under sokosumi:task:<id>.');
  store.close();
  process.exit(0);
}

const bus = createEventBus();
const sources: FreelancerSource[] = [createFreelancerSource(config), createRentAHumanSource(config), ...createBrowserSources({ config, bus })];
if (config.SOURCES?.split(',').map((s) => s.trim()).includes('fake')) sources.push(createFakeSource());
const registry = createRegistry({ sources, store, bus, config });
const router = createRouter({ registry, suitability: createSuitabilityScorer({ store, config }), bus, config });
const policy = createPolicy({ store, config });
const gate = createApprovalGate({ store, bus, policy, config });
const bookings = createBookingService({ store, bus, registry, escrow: createEscrowProvider({ store, config }), gate, config });
const jobs = createJobService({ store, bus, router, bookings, config });

const worker = sokosumiWorkerFromConfig({ config, store, jobs })!;

if (args.has('--once')) {
  await worker.tick();
  await worker.drain();
  await worker.tick();
  store.close();
  process.exit(0);
}

worker.start();
// Keep the process alive; the worker's timer is unref'd so `pnpm start` can exit cleanly.
const keepAlive = setInterval(() => {}, 1 << 30);
const stop = () => {
  worker.stop();
  clearInterval(keepAlive);
  void worker.drain().finally(() => {
    store.close();
    process.exit(0);
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
