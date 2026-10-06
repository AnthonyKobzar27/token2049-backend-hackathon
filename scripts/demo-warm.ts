// Warms the profile and suitability caches for the stage demo, then times a pinned run.
// Usage: pnpm demo:warm [briefs.json]   (a JSON array of Briefs; defaults to the briefs below)
// Then start with DEMO_MODE=true: cached results never expire and a shortlist returns in ~2 s.

import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config';
import { createStore } from '../src/db/db';
import { createEventBus } from '../src/domain/events';
import type { FreelancerSource } from '../src/domain/ports';
import type { Brief } from '../src/domain/types';
import { createRouter } from '../src/router/router';
import { createSuitabilityScorer } from '../src/router/suitability';
import { createBrowserSources } from '../src/sources/browser';
import { createFakeSource } from '../src/sources/fake';
import { createFreelancerSource } from '../src/sources/freelancer';
import { createRegistry } from '../src/sources/registry';
import { createRentAHumanSource } from '../src/sources/rentahuman';

const DEFAULT_BRIEFS: Brief[] = [
  { task: 'Pick up a parcel near Marina Bay and deliver it to our booth', skills: ['errands', 'delivery'], location: 'Marina Bay, Singapore', remoteOk: false, budgetUsd: 80, hoursNeeded: 3, when: { date: '2026-10-10', window: { start: '14:00', end: '17:00' }, timezone: 'Asia/Singapore' } },
  { task: 'Design a logo for a crypto coffee shop', skills: ['logo design', 'branding'], remoteOk: true, budgetUsd: 200, deadlineDays: 5 },
  { task: 'Audit a Solidity escrow contract', skills: ['solidity', 'smart contracts', 'security audit'], remoteOk: true, budgetUsd: 2000, hoursNeeded: 15 },
  { task: 'Edit a 3 minute event recap video', skills: ['video editing'], remoteOk: true, budgetUsd: 300, deadlineDays: 3 },
];

const file = process.argv[2];
const briefs: Brief[] = file ? (JSON.parse(readFileSync(file, 'utf8')) as Brief[]) : DEFAULT_BRIEFS;
const base = loadConfig();

function build(demo: boolean) {
  const config = { ...base, DEMO_MODE: demo, SEARCH_BUDGET_MS: demo ? base.SEARCH_BUDGET_MS : Math.max(base.SEARCH_BUDGET_MS, 30_000) };
  const store = createStore(config.DB_PATH);
  const bus = createEventBus();
  const sources: FreelancerSource[] = [createFreelancerSource(config), createRentAHumanSource(config), ...createBrowserSources({ config, bus }), createFakeSource()];
  // Keep the fixtures on even when SOURCES lists only live platforms (demo mode does this itself).
  const registry = createRegistry({ sources, store, bus, config: { ...config, SOURCES: config.SOURCES && `${config.SOURCES},fake` } });
  const router = createRouter({ registry, suitability: createSuitabilityScorer({ store, config }), bus, config });
  return { store, registry, router };
}

console.log(`Warming ${briefs.length} briefs into ${base.DB_PATH}`);
const warm = build(false);
for (const brief of briefs) {
  const t0 = Date.now();
  const r = await warm.router.route(brief, { limit: base.SHORTLIST_SIZE });
  await warm.registry.settle();
  const src = r.sources.map((s) => `${s.source}:${s.ok ? s.count : s.late ? 'late' : 'fail'}`).join(' ');
  console.log(`  ${Date.now() - t0} ms  ${brief.task.slice(0, 50)}  [${src}]`);
}
// Suitability calls that missed the budget are cached when they land; give them a moment.
await new Promise((r) => setTimeout(r, 3_000));
warm.store.close();

console.log('\nPinned demo run:');
const demo = build(true);
for (const brief of briefs) {
  const t0 = Date.now();
  const r = await demo.router.route(brief, { limit: base.SHORTLIST_SIZE });
  const top = r.candidates[0];
  console.log(`  ${Date.now() - t0} ms  ${brief.task.slice(0, 50)}  -> ${top ? `${top.profile.name} (${top.score})` : 'none'}`);
}
demo.store.close();
