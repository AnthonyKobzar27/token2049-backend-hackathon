// Usage: tsx scripts/browser-smoke.ts [site] [query]
// Needs Chrome started by scripts/start-chrome.sh (or CHROME_CDP_URL pointing at one).
import { loadConfig } from '../src/config';
import type { EventBus } from '../src/domain/ports';
import { disconnect, isReachable, withTab } from '../src/sources/browser/cdp';
import { extractProfiles } from '../src/sources/browser/extract';
import { readPage } from '../src/sources/browser/reader';
import { siteFor } from '../src/sources/browser/sites';
import { hasLlm } from '../src/llm/client';

const config = loadConfig();
const siteName = process.argv[2] ?? 'fiverr';
const query = process.argv[3] ?? 'logo design';
const site = siteFor(siteName);
if (!site) {
  console.error(`unknown site "${siteName}" (fiverr, peopleperhour, guru)`);
  process.exit(1);
}

const bus: EventBus = {
  emit: (e) => {
    if (e.type === 'operator.attention') console.log(`\n>>> ATTENTION [${e.source}] ${e.message} ${e.url ?? ''}\n`);
  },
  on: () => () => {},
};

const brief = { task: query, skills: [query], remoteOk: true };

try {
  const reachable = await isReachable(config);
  console.log(`CDP ${config.CHROME_CDP_URL}: ${reachable ? 'reachable' : 'NOT reachable (run scripts/start-chrome.sh)'}`);
  if (!reachable) process.exit(2);

  const url = site.searchUrl(brief);
  console.log(`reading ${url}`);
  const read = await withTab(config, (page) => readPage(page, url, { bus, site: site.name, linkPattern: site.profileUrlPattern }));
  console.log(`status ${read.status ?? '?'}, title "${read.title}", final url ${read.url}`);
  console.log(`challenge: ${read.challenge}${read.challengeReason ? ` (${read.challengeReason})` : ''}; ${read.text.length} chars`);

  if (!hasLlm(config)) {
    console.log('\nNo ANTHROPIC_API_KEY: showing the first 1500 characters of the page text.\n');
    console.log(read.text.slice(0, 1500));
  } else {
    const profiles = await extractProfiles(read.text, site, brief, config);
    console.log(`\n${profiles.length} profiles\n`);
    console.table(
      profiles.map((p) => ({
        name: p.name.slice(0, 22),
        headline: p.headline.slice(0, 40),
        price: p.pricing[0] ? `${p.pricing[0].amountUsd} USD ${p.pricing[0].kind}` : '-',
        rating: p.rating ?? '-',
        reviews: p.reviewCount ?? '-',
        level: p.level ?? '-',
        id: p.id.slice(0, 40),
      })),
    );
  }
} finally {
  await disconnect();
}
