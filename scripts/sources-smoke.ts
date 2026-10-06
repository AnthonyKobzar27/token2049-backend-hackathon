// Live read-only search on the Freelancer.com and RentAHuman sources, printed as a table.
import { loadConfig } from '../src/config';
import type { Brief, FreelancerProfile } from '../src/domain/types';
import { createFreelancerSource } from '../src/sources/freelancer';
import { createRentAHumanSource } from '../src/sources/rentahuman';

const brief: Brief = { task: 'Design a logo for a coffee shop', skills: ['logo design'], remoteOk: true };
const config = loadConfig();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const rows: string[][] = [['platform', 'name', 'headline', 'country', 'price', 'rating/reviews']];
for (const source of [createFreelancerSource(config), createRentAHumanSource(config)]) {
  const t0 = Date.now();
  try {
    const found: FreelancerProfile[] = await source.search(brief, { limit: 5 });
    console.log(`${source.name}: ${found.length} profiles in ${Date.now() - t0} ms`);
    for (const p of found) {
      const price = p.pricing[0] ? `$${p.pricing[0].amountUsd}/${p.pricing[0].kind === 'hourly' ? 'h' : 'fixed'}` : '-';
      const rating = p.rating !== undefined ? `${p.rating}/${p.reviewCount}` : `-/${p.reviewCount ?? '-'}`;
      rows.push([p.platform, cut(p.name, 22), cut(p.headline, 40), p.country ?? '-', price, rating]);
    }
  } catch (err) {
    console.log(`${source.name}: FAILED ${err instanceof Error ? err.message : err}`);
  }
}
const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i]!)).join('  '));
