import type { Config } from '../../config';
import type { EventBus, FreelancerSource, SearchOptions } from '../../domain/ports';
import type { BookingRequest, BookingResult, Brief, FreelancerProfile } from '../../domain/types';
import { isReachable, lastKnownReachable, paceNavigation, setChromeVisible, withTab } from './cdp';
import { contactInstructions, contactMessage, contactOnPage } from './contact';
import { extractProfiles } from './extract';
import { readPage } from './reader';
import { queryVariants } from '../http';
import { siteFor, type SiteDef } from './sites';

/** A page read costs seconds: a search widens to the next, broader phrase only when it found nobody. */
const ENOUGH = 1;

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
      // Most specific phrase first; widen when a page has too few people on it.
      const seen = new Set<string>();
      const found: FreelancerProfile[] = [];
      for (const phrase of queryVariants(brief.skills, brief.task)) {
        const narrowed: Brief = { ...brief, skills: [phrase] };
        const read = await withTab(config, (page) =>
          readPage(page, site.searchUrl(narrowed), { bus, site: site.name, linkPattern: site.profileUrlPattern, signal: opts.signal, reveal: (v) => setChromeVisible(config.CHROME_CDP_URL, v) }),
        );
        if (read.challenge === 'blocked') throw new Error(`${site.name}: blocked by a human check`);
        if (opts.signal?.aborted) throw new Error(`${site.name}: aborted`);
        for (const p of await extractProfiles(read.text, site, brief, config)) {
          if (!seen.has(p.id)) {
            seen.add(p.id);
            found.push(p);
          }
        }
        if (found.length >= Math.min(ENOUGH, opts.limit)) break;
      }
      return found.slice(0, Math.max(0, opts.limit));
    },

    async book(request: BookingRequest): Promise<BookingResult> {
      const { profile, brief, priceUsd } = request;
      const url = profile.url;
      if (config.BROWSER_CONTACT && site.contact) {
        // Message the freelancer with the brief and ask for an offer. Never orders or pays.
        const reveal = (v: boolean) => setChromeVisible(config.CHROME_CDP_URL, v);
        const outcome = await withTab(config, (page) => contactOnPage(page, url, site.contact!, contactMessage(brief, priceUsd), { bus, site: site.name, reveal })).catch((err: unknown) => ({
          status: 'error' as const,
          url,
          error: err instanceof Error ? err.message : String(err),
        }));
        const instructions = contactInstructions(site.name, profile.name, outcome, priceUsd);
        if (outcome.status !== 'sent') bus.emit({ type: 'operator.attention', source: site.name, message: instructions, url: outcome.url });
        return { kind: 'handoff', url: outcome.url || url, platformRef: outcome.status === 'sent' ? outcome.url : undefined, instructions };
      }
      // Open the page for the operator. Never click anything on it.
      await withTab(config, async (page) => {
        await paceNavigation(undefined, undefined, url);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
        await page.bringToFront().catch(() => undefined);
      }).catch(() => undefined);
      return {
        kind: 'handoff',
        url,
        instructions: `Review the listing in the Chrome window and complete the order yourself on ${site.name}. Choose the package that matches the brief (about $${priceUsd}), check the delivery time and extras, and pay there. HAAS does not click order or pay.`,
      };
    },
  };
}

export function createBrowserSources(deps: { config: Config; bus: EventBus }): FreelancerSource[] {
  const names = deps.config.BROWSER_SITES.split(',').map((s) => s.trim()).filter(Boolean);
  const out: FreelancerSource[] = [];
  for (const name of names) {
    // Fiverr has a dedicated source (src/sources/fiverr.ts) with the same name.
    if (name.toLowerCase() === 'fiverr') continue;
    const site = siteFor(name);
    if (!site) {
      console.warn(`[browser] unknown site "${name}" in BROWSER_SITES, skipped`);
      continue;
    }
    out.push(createBrowserSource(site, deps));
  }
  return out;
}
