// Times a real search end to end: every source, then scoring and ranking, as the server does it.
// Usage: pnpm tsx scripts/search-timing.ts ["task text"] [--in-person]
import { loadConfig } from '../src/config';
import type { Brief } from '../src/domain/types';
import type { FreelancerSource } from '../src/domain/ports';
import { createEventBus } from '../src/domain/events';
import { createStore } from '../src/db/db';
import { createRegistry } from '../src/sources/registry';
import { createSuitabilityScorer } from '../src/router/suitability';
import { createRouter } from '../src/router/router';
import { createRentAHumanSource } from '../src/sources/rentahuman';
import { createFiverrSource } from '../src/sources/fiverr';
import { createFreelancerSource } from '../src/sources/freelancer';
import { createBrowserSources } from '../src/sources/browser';

const config = loadConfig();
const store = createStore(':memory:');
const bus = createEventBus();
const sources: FreelancerSource[] = [createRentAHumanSource(config), createFiverrSource({ config, bus }), createFreelancerSource(config), ...createBrowserSources({ config, bus })];
const registry = createRegistry({ sources, store, bus, config });
const router = createRouter({ registry, suitability: createSuitabilityScorer({ store, config }), bus, config });

const args = process.argv.slice(2);
const inPerson = args.includes('--in-person');
const task = args.find((a) => !a.startsWith('--')) ?? (inPerson ? 'Wait in line for me at the Apple Store Orchard Road' : 'SAT math tutor for 2 hours this weekend');
const brief: Brief = inPerson
  ? { task, skills: ['line sitter', 'errands'], remoteOk: false, location: 'Singapore', taskType: 'in_person', budgetUsd: 40, hoursNeeded: 2 }
  : { task, skills: ['SAT tutoring', 'math tutor'], remoteOk: true, budgetUsd: 80, hoursNeeded: 2, language: 'English' };

for (const s of sources) {
  if (!s.isEnabled()) { console.log(`${s.name}: disabled`); continue; }
  const t0 = Date.now();
  try {
    const found = await Promise.race([s.search(brief, { limit: 25 }), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no answer in 60 s')), 60_000))]);
    console.log(`${s.name}: ${found.length} profiles in ${Date.now() - t0} ms`);
  } catch (err) {
    console.log(`${s.name}: FAILED after ${Date.now() - t0} ms: ${err instanceof Error ? err.message : err}`);
  }
}
const t0 = Date.now();
const { candidates, sources: used } = await router.route(brief, { limit: 3 });
console.log(`\nrouter: ${Date.now() - t0} ms, sources ${used.map((u) => `${JSON.stringify(u)}`).join(', ')}`);
for (const c of candidates) console.log(`- ${c.profile.platform} ${c.profile.name}: ${c.profile.headline?.slice(0, 60)} | $${c.profile.pricing[0]?.amountUsd ?? '?'} | score ${c.score}`);
process.exit(0);
