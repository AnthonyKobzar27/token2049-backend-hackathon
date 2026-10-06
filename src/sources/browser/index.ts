import type { Config } from '../../config';
import type { EventBus, FreelancerSource, SearchOptions } from '../../domain/ports';
import type { BookingRequest, BookingResult, Brief, FreelancerProfile } from '../../domain/types';
import { isReachable, lastKnownReachable, paceNavigation, withTab } from './cdp';
import { extractProfiles } from './extract';
import { readPage } from './reader';
import { siteFor, type SiteDef } from './sites';

function createBrowserSource(site: SiteDef, deps: { config: Config; bus: EventBus }): FreelancerSource {
  const { config, bus } = deps;
  const refresh = () => void isReachable(config).catch(() => undefined);
  refresh(); // starts pessimistic, settles within a second or two

  return {
    name: site.name,
    platform: site.platform,
    kind: 'browser',

    isEnabled() {
      refresh();
      return lastKnownReachable();
    },

    async search(brief: Brief, opts: SearchOptions): Promise<FreelancerProfile[]> {
      if (opts.signal?.aborted) throw new Error(`${site.name}: aborted`);
      if (!(await isReachable(config))) throw new Error(`${site.name}: Chrome is not reachable at ${config.CHROME_CDP_URL} (run scripts/start-chrome.sh)`);
      const read = await withTab(config, (page) =>
        readPage(page, site.searchUrl(brief), { bus, site: site.name, linkPattern: site.profileUrlPattern, signal: opts.signal }),
      );
      if (read.challenge === 'blocked') throw new Error(`${site.name}: blocked by a human check`);
      if (opts.signal?.aborted) throw new Error(`${site.name}: aborted`);
      const profiles = await extractProfiles(read.text, site, brief, config);
      return profiles.slice(0, Math.max(0, opts.limit));
    },

    async book(request: BookingRequest): Promise<BookingResult> {
      const url = request.profile.url;
      // Open the page for the operator. Never click anything on it.
      await withTab(config, async (page) => {
        await paceNavigation();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
        await page.bringToFront().catch(() => undefined);
      }).catch(() => undefined);
      return {
        kind: 'handoff',
        url,
        instructions: `Review the gig in the Chrome window and complete the order yourself on ${site.name}. Choose the package that matches the brief (about $${request.priceUsd}), check the delivery time and extras, and pay there. HAAS does not click order or pay.`,
      };
    },
  };
}

export function createBrowserSources(deps: { config: Config; bus: EventBus }): FreelancerSource[] {
  const names = deps.config.BROWSER_SITES.split(',').map((s) => s.trim()).filter(Boolean);
  const out: FreelancerSource[] = [];
  for (const name of names) {
    const site = siteFor(name);
    if (!site) {
      console.warn(`[browser] unknown site "${name}" in BROWSER_SITES, skipped`);
      continue;
    }
    out.push(createBrowserSource(site, deps));
  }
  return out;
}
