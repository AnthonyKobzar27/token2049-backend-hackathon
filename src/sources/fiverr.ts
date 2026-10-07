// Fiverr source. Fiverr publishes no API, so:
// - Search goes through the free, open-source Fiverr MCP server (github.com/KyuRish/fiverr-mcp-server),
//   run as a child process over stdio. It reads the structured data Fiverr embeds in its public pages.
//   If it is unavailable, the same data is read from the page in the operator's Chrome.
// - Booking messages the seller from the operator's logged-in Chrome (brief + request for an offer).
//   Placing and paying for the order stays with a person: HAAS never clicks order or pay.
// Reading Fiverr with automation is against its terms: use a dedicated account and human pace.

import type { Config } from '../config';
import type { EventBus, FreelancerSource, SearchOptions } from '../domain/ports';
import type { BookingRequest, BookingResult, Brief, FreelancerProfile } from '../domain/types';
import { isReachable, setChromeVisible, withTab } from './browser/cdp';
import { contactInstructions, contactMessage, contactOnPage } from './browser/contact';
import { normalise, type RawListing } from './browser/extract';
import { queryVariants } from './http';
import { SITES } from './browser/sites';

/** One search result, as the MCP server's `search_gigs` returns it. */
export interface McpGig {
  title?: string;
  seller_name?: string;
  seller_level?: string;
  /** Starting price. The server divides Fiverr's dollar figure by 100 by mistake; see `gigToRaw`. */
  price?: number;
  rating?: number;
  reviews_count?: number;
  url?: string;
}

/** One item of Fiverr's embedded search data (`perseus-initial-props` → `items`). */
export interface PerseusItem {
  title?: string;
  seller_name?: string;
  seller_level?: string;
  /** Starting price in whole currency units. */
  price_i?: number;
  buying_review_rating?: number;
  buying_review_rating_count?: number;
  gig_url?: string;
}

/** Talks to an MCP tool. Injectable so tests need no Python. */
export type McpCall = (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

const LEVELS: Record<string, string> = {
  level_one_seller: 'Level 1',
  level_two_seller: 'Level 2',
  top_rated_seller: 'Top Rated',
  pro: 'Pro',
};

const SITE = SITES.fiverr!;

function raw(fields: Partial<RawListing>): RawListing {
  return {
    name: null, headline: null, url: null, priceAmount: null, priceCurrency: null, priceUnit: null, deliveryDays: null,
    rating: null, reviewCount: null, level: null, country: null, languages: null, skills: null, online: null,
    ...fields,
  };
}

const ratingOf = (rating?: number, count?: number): number | null => (count && rating && rating > 0 ? rating : null);

export function gigToRaw(g: McpGig): RawListing {
  return raw({
    name: g.seller_name ?? null,
    headline: g.title ?? null,
    url: g.url ?? null,
    // fiverr-mcp-server 0.1.x reads `price_i` (already dollars) and divides it by 100 again.
    priceAmount: typeof g.price === 'number' && g.price > 0 ? Math.round(g.price * 100 * 100) / 100 : null,
    priceCurrency: 'USD',
    priceUnit: 'fixed',
    rating: ratingOf(g.rating, g.reviews_count),
    reviewCount: typeof g.reviews_count === 'number' ? g.reviews_count : null,
    level: g.seller_level ? (LEVELS[g.seller_level] ?? g.seller_level) : null,
  });
}

export function perseusToRaw(item: PerseusItem, currency: string): RawListing {
  const url = item.gig_url ? new URL(item.gig_url, SITE.origin).toString() : null;
  return raw({
    name: item.seller_name ?? null,
    headline: item.title ?? null,
    url,
    priceAmount: typeof item.price_i === 'number' && item.price_i > 0 ? item.price_i : null,
    priceCurrency: currency,
    priceUnit: 'fixed',
    rating: ratingOf(item.buying_review_rating, item.buying_review_rating_count),
    reviewCount: typeof item.buying_review_rating_count === 'number' ? item.buying_review_rating_count : null,
    level: item.seller_level ? (LEVELS[item.seller_level] ?? item.seller_level) : null,
  });
}

/** Unwraps an MCP tool result: structured content first, then the JSON text block. */
export function toolPayload(result: unknown): Record<string, unknown> {
  const r = result as { structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[]; isError?: boolean };
  if (r?.isError) throw new Error(`fiverr MCP tool error: ${r.content?.find((c) => c.type === 'text')?.text ?? 'unknown'}`);
  const sc = r?.structuredContent;
  if (sc && typeof sc === 'object') {
    const inner = (sc as { result?: unknown }).result;
    return (inner && typeof inner === 'object' ? inner : sc) as Record<string, unknown>;
  }
  const text = r?.content?.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error('fiverr MCP returned no content');
  return JSON.parse(text) as Record<string, unknown>;
}

/** A lazily started stdio MCP client for the Fiverr server. Restarts after a failure. */
export function createFiverrMcp(config: Config): { call: McpCall; warm: () => void; close: () => Promise<void> } {
  let client: Promise<{ callTool: (req: { name: string; arguments: Record<string, unknown> }, schema?: unknown, opts?: { signal?: AbortSignal; timeout?: number }) => Promise<unknown>; close: () => Promise<void> }> | undefined;

  async function start() {
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
    ]);
    const args = config.FIVERR_MCP_ARGS.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? [];
    const transport = new StdioClientTransport({ command: config.FIVERR_MCP_COMMAND, args, stderr: 'ignore' });
    const c = new Client({ name: 'haas', version: '0.1.0' });
    await c.connect(transport);
    return c as unknown as Awaited<NonNullable<typeof client>>;
  }

  return {
    /** Starts the server in the background so the first search does not pay for uvx and Python start-up. */
    warm() {
      client ??= start();
      client.catch(() => {
        client = undefined;
      });
    },
    async call(tool, args, signal) {
      client ??= start();
      try {
        const c = await client;
        return await c.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: config.FIVERR_MCP_TIMEOUT_MS });
      } catch (err) {
        const dead = client;
        client = undefined;
        void dead?.then((c) => c.close()).catch(() => undefined);
        throw err;
      }
    },
    async close() {
      const c = client;
      client = undefined;
      await c?.then((x) => x.close()).catch(() => undefined);
    },
  };
}

export interface FiverrDeps {
  config: Config;
  bus: EventBus;
  /** Defaults to the stdio MCP client above. */
  mcp?: McpCall;
  /** Test hook for the Chrome fallback. */
  readPerseus?: (url: string, signal?: AbortSignal) => Promise<{ items: PerseusItem[]; currency: string } | null>;
  /** Test hook for the booking step. */
  contact?: typeof contactOnPage;
}

async function chromePerseus(config: Config, url: string): Promise<{ items: PerseusItem[]; currency: string } | null> {
  if (!(await isReachable(config))) return null;
  return withTab(config, async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const text = await page.evaluate<string | null>(`document.getElementById('perseus-initial-props')?.textContent ?? null`);
    if (!text) return null;
    const props = JSON.parse(text) as { items?: PerseusItem[]; currency?: { name?: string }; userCurrency?: string };
    // The page shows the visitor's chosen currency (cookie); USD unless the profile picked another.
    const currency = props.currency?.name ?? props.userCurrency ?? 'USD';
    return { items: props.items ?? [], currency };
  });
}

export function createFiverrSource(deps: FiverrDeps): FreelancerSource {
  const { config } = deps;
  let mcp = deps.mcp;
  if (!mcp && config.FIVERR_SEARCH === 'mcp') {
    const server = createFiverrMcp(config);
    server.warm();
    mcp = server.call;
  }
  const readPerseus = deps.readPerseus ?? ((url: string) => chromePerseus(config, url));
  const contact = deps.contact ?? contactOnPage;

  function toProfiles(raws: RawListing[], limit: number): FreelancerProfile[] {
    const seen = new Set<string>();
    const out: FreelancerProfile[] = [];
    const now = Date.now();
    for (const r of raws) {
      if (!r.name?.trim() || !r.url) continue;
      const p = normalise(r, SITE, now);
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
      if (out.length >= limit) break;
    }
    return out;
  }

  async function search(brief: Brief, opts: SearchOptions): Promise<FreelancerProfile[]> {
    // Most specific phrase first; widen when Fiverr finds too few gigs ("sat math tutor" -> "sat math" -> "sat").
    const phrases = queryVariants(brief.skills, brief.task);
    let mcpError: unknown;
    if (mcp) {
      try {
        const gigs: McpGig[] = [];
        for (const query of phrases) {
          const args: Record<string, unknown> = { query };
          if (brief.budgetUsd && brief.budgetUsd > 0) args.max_price = Math.ceil(brief.budgetUsd);
          const payload = toolPayload(await mcp('search_gigs', args, opts.signal));
          if (payload.error) throw new Error(String(payload.error));
          gigs.push(...(Array.isArray(payload.gigs) ? (payload.gigs as McpGig[]) : []));
          if (toProfiles(gigs.map(gigToRaw), opts.limit).length >= Math.min(3, opts.limit)) break;
        }
        return toProfiles(gigs.map(gigToRaw), opts.limit);
      } catch (err) {
        mcpError = err;
        if (opts.signal?.aborted) throw err;
      }
    }
    for (const phrase of phrases) {
      const fromChrome = await readPerseus(SITE.searchUrl({ ...brief, skills: [phrase] }), opts.signal).catch(() => null);
      if (!fromChrome) break;
      const out = toProfiles(fromChrome.items.map((i) => perseusToRaw(i, fromChrome.currency)), opts.limit);
      if (out.length >= Math.min(3, opts.limit) || phrase === phrases.at(-1)) return out;
    }
    if (mcpError) throw new Error(`fiverr: MCP search failed (${mcpError instanceof Error ? mcpError.message : String(mcpError)}) and Chrome is not reachable`);
    throw new Error(`fiverr: no search backend (FIVERR_SEARCH=${config.FIVERR_SEARCH}) and Chrome is not reachable at ${config.CHROME_CDP_URL}`);
  }

  async function book(request: BookingRequest): Promise<BookingResult> {
    const { profile, brief, priceUsd } = request;
    const url = profile.url;
    if (!config.BROWSER_CONTACT || !(await isReachable(config).catch(() => false))) {
      return {
        kind: 'handoff',
        url,
        instructions: `Open ${profile.name}'s Fiverr gig, send them the brief and order the package that matches it (about $${Math.round(priceUsd)}). HAAS does not click order or pay.`,
      };
    }
    const reveal = (v: boolean) => setChromeVisible(config.CHROME_CDP_URL, v);
    const outcome = await withTab(config, (page) => contact(page, url, SITE.contact!, contactMessage(brief, priceUsd), { bus: deps.bus, site: 'Fiverr', reveal })).catch((err: unknown) => ({
      status: 'error' as const,
      url,
      error: err instanceof Error ? err.message : String(err),
    }));
    if (outcome.status !== 'sent') {
      deps.bus.emit({ type: 'operator.attention', source: 'fiverr', message: contactInstructions('Fiverr', profile.name, outcome, priceUsd), url: outcome.url });
    }
    return {
      kind: 'handoff',
      url: outcome.status === 'sent' ? outcome.url : url,
      platformRef: outcome.status === 'sent' ? outcome.url : undefined,
      instructions: contactInstructions('Fiverr', profile.name, outcome, priceUsd),
    };
  }

  return {
    name: 'fiverr',
    platform: 'fiverr',
    kind: 'api',
    // The first call may download the MCP server with uvx.
    timeoutMs: config.FIVERR_MCP_TIMEOUT_MS,
    isEnabled: () => config.FIVERR_SEARCH !== 'off',
    search,
    book,
  };
}
